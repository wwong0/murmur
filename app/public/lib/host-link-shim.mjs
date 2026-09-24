// HTTP-shaped facades over a HostLink.  All page implementations are
// injected by the caller; this module deliberately has no DOM assumptions.

import { parseRange } from './segment-protocol.mjs';

const UNSENT = 0;
const OPENED = 1;
const HEADERS_RECEIVED = 2;
const LOADING = 3;
const DONE = 4;

function mediaTarget(input, baseUrl) {
  try {
    const url = new URL(input, baseUrl);
    return url.origin === new URL(baseUrl).origin && url.pathname.startsWith('/media/') ? url : null;
  } catch {
    return null;
  }
}

function requestParts(input, init) {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const source = isRequest ? input : null;
  const method = String(init?.method ?? source?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers ?? source?.headers ?? undefined);
  const signal = init?.signal ?? source?.signal;
  return { url: source ? source.url : String(input), method, headers, signal };
}

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function failedFetch() {
  return new TypeError('Failed to fetch');
}

function contentRange(range, head) {
  const start = range?.start ?? 0;
  const end = range?.end === null || range?.end === undefined ? start + head.length - 1 : range.end;
  return `bytes ${start}-${end}/${head.total ?? '*'}`;
}

/** Build the fetch replacement without installing it on a global. */
export function createShimFetch({ link, realFetch, baseUrl } = {}) {
  if (!link || typeof link.request !== 'function') throw new TypeError('createShimFetch: link is required');
  return function shimFetch(input, init) {
    const parts = requestParts(input, init);
    const target = mediaTarget(parts.url, baseUrl);
    if (!target) return realFetch(input, init);
    if (parts.method !== 'GET') return Promise.reject(failedFetch());

    const range = parseRange(parts.headers.get('range'));
    if (parts.signal?.aborted) return Promise.reject(abortError());

    let controller;
    let settled = false;
    let aborted = false;
    let ended = false;
    let handle = null;
    let resolveResponse;
    let rejectResponse;
    const outer = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const stream = new ReadableStream({
      start(value) {
        controller = value;
      },
      cancel() {
        if (!aborted && !ended) abort();
      },
    });

    const fail = (afterHead) => {
      if (aborted || ended) return;
      const error = failedFetch();
      if (!afterHead) {
        settled = true;
        rejectResponse(error);
      } else {
        try { controller?.error(error); } catch { /* stream already closed */ }
      }
    };
    const abort = () => {
      if (aborted || ended) return;
      aborted = true;
      handle?.abort();
      if (!settled) {
        settled = true;
        rejectResponse(abortError());
      }
      try { controller?.error(abortError()); } catch { /* stream not started */ }
    };
    const onSignal = () => abort();
    parts.signal?.addEventListener('abort', onSignal, { once: true });

    handle = link.request({
      path: target.pathname,
      range,
      handlers: {
        onHead(head) {
          if (aborted || ended) return;
          const headers = new Headers({ 'Content-Length': String(head.length) });
          if (head.status === 206) headers.set('Content-Range', contentRange(range, head));
          settled = true;
          resolveResponse(new Response(stream, { status: head.status, headers }));
        },
        onChunk(chunk) {
          if (aborted || !settled) return;
          try { controller.enqueue(chunk); } catch { /* stream canceled */ }
        },
        onEnd() {
          if (aborted || !settled) return;
          ended = true;
          parts.signal?.removeEventListener('abort', onSignal);
          try { controller.close(); } catch { /* stream canceled */ }
        },
        onError() {
          const afterHead = settled && !aborted;
          parts.signal?.removeEventListener('abort', onSignal);
          fail(afterHead);
        },
      },
    });
    return outer;
  };
}

function statusText(status) {
  return ({ 200: 'OK', 206: 'Partial Content', 404: 'Not Found', 416: 'Range Not Satisfiable', 500: 'Internal Server Error', 502: 'Bad Gateway' })[status] ?? (status ? String(status) : '');
}

function fire(target, type, extra = {}) {
  const event = { type, target, ...extra };
  const property = target[`on${type}`];
  if (typeof property === 'function') {
    try { property.call(target, event); } catch { /* one handler cannot suppress the next */ }
  }
  const listeners = target._listeners.get(type);
  if (!listeners) return;
  for (const fn of [...listeners]) {
    try { fn.call(target, event); } catch { /* event listener isolation */ }
  }
}

class LinkXhr {
  constructor(link, path, rejectMethod) {
    this._link = link;
    this._path = path;
    this._url = '';
    this._rejectMethod = rejectMethod;
    this._headers = new Map();
    this._responseHeaders = new Map();
    this._chunks = [];
    this._received = 0;
    this._length = 0;
    this._handle = null;
    this._settled = false;
    this._aborted = false;
    this._listeners = new Map();
    this.readyState = UNSENT;
    this.status = 0;
    this.statusText = '';
    this.response = null;
    this.responseText = '';
    this.responseURL = '';
    this.responseType = '';
    this.timeout = 0;
    this.withCredentials = false;
    this.onreadystatechange = null;
    this.onloadstart = null;
    this.onprogress = null;
    this.onload = null;
    this.onloadend = null;
    this.onerror = null;
    this.onabort = null;
    this.ontimeout = null;
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  setRequestHeader(name, value) {
    this._headers.set(String(name).toLowerCase(), String(value));
  }

  getResponseHeader(name) {
    return this._responseHeaders.get(String(name).toLowerCase()) ?? null;
  }

  getAllResponseHeaders() {
    return [...this._responseHeaders].map(([name, value]) => `${name}: ${value}\r\n`).join('');
  }

  _state(value) {
    this.readyState = value;
    fire(this, 'readystatechange');
  }

  open(method, url) {
    this._url = String(url);
    this._state(OPENED);
  }

  send() {
    fire(this, 'loadstart');
    if (this._rejectMethod) {
      queueMicrotask(() => this._fail());
      return;
    }
    this._handle = this._link.request({
      path: this._path,
      range: parseRange(this._headers.get('range')),
      handlers: {
        onHead: (head) => this._head(head),
        onChunk: (chunk) => this._chunk(chunk),
        onEnd: () => this._end(),
        onError: () => this._fail(),
      },
    });
  }

  _head(head) {
    if (this._settled || this._aborted) return;
    this.status = head.status;
    this.statusText = statusText(head.status);
    this.responseURL = this._url;
    this._length = head.length;
    this._responseHeaders.set('content-length', String(head.length));
    if (head.status === 206) this._responseHeaders.set('content-range', contentRange(parseRange(this._headers.get('range')), head));
    this._state(HEADERS_RECEIVED);
  }

  _chunk(chunk) {
    if (this._settled || this._aborted) return;
    this._chunks.push(new Uint8Array(chunk));
    this._received += chunk.byteLength;
    if (this.readyState < LOADING) this._state(LOADING);
    fire(this, 'progress', { loaded: this._received, total: this._length, lengthComputable: true });
  }

  _end() {
    if (this._settled || this._aborted) return;
    if (this.responseType !== '' && this.responseType !== 'arraybuffer' && this.responseType !== 'text') {
      this._fail();
      return;
    }
    const bytes = new Uint8Array(this._received);
    let offset = 0;
    for (const chunk of this._chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (this.responseType === 'arraybuffer') {
      this.response = bytes.buffer;
    } else {
      this.responseText = new TextDecoder().decode(bytes);
      this.response = this.responseText;
    }
    this._settled = true;
    this._state(DONE);
    fire(this, 'load');
    fire(this, 'loadend');
  }

  _fail() {
    if (this._settled || this._aborted) return;
    this._settled = true;
    this.status = 0;
    this.statusText = '';
    this._state(DONE);
    fire(this, 'error');
    fire(this, 'loadend');
  }

  abort() {
    if (this._settled || this._aborted) return;
    this._aborted = true;
    this._handle?.abort();
    this._handle = null;
    this.readyState = UNSENT;
    this.status = 0;
    fire(this, 'abort');
    fire(this, 'loadend');
  }
}

/** Return an XMLHttpRequest constructor that routes only media GETs. */
export function createShimXhr({ link, RealXHR, baseUrl } = {}) {
  const Real = RealXHR ?? globalThis.XMLHttpRequest;
  if (!link || typeof link.request !== 'function') throw new TypeError('createShimXhr: link is required');

  class ShimXMLHttpRequest {
    constructor() {
      this._backing = null;
      this._pendingHeaders = [];
      this._pendingResponseType = '';
      this._pendingProperties = new Map();
      this._pendingListeners = [];
    }

    _use(backing) {
      this._backing = backing;
      if (this._pendingResponseType) backing.responseType = this._pendingResponseType;
      for (const [name, value] of this._pendingProperties) backing[name] = value;
      // A listener added before open is replayed, not copied as a field (7a d1-findings D1-2).
      for (const [type, fn, options] of this._pendingListeners) backing.addEventListener(type, fn, options);
    }

    _replayHeaders() {
      for (const [name, value] of this._pendingHeaders) this._backing.setRequestHeader(name, value);
    }

    open(method, url, ...rest) {
      const target = mediaTarget(url, baseUrl);
      // A media request of any method goes to the link, which fails a non-GET.
      const backing = target
        ? new LinkXhr(link, target.pathname, String(method || 'GET').toUpperCase() !== 'GET')
        : new Real();
      this._use(backing);
      backing.open(method, target ? target.href : url, ...rest);
      this._replayHeaders();
    }

    setRequestHeader(name, value) {
      if (this._backing) this._backing.setRequestHeader(name, value);
      else this._pendingHeaders.push([name, value]);
    }

    send(body) { this._backing.send(body); }
    abort() { this._backing?.abort(); }
    addEventListener(type, fn, options) {
      if (this._backing) this._backing.addEventListener(type, fn, options);
      else this._pendingListeners.push([type, fn, options]);
    }
    removeEventListener(type, fn) { this._backing?.removeEventListener(type, fn); }
    getAllResponseHeaders() { return this._backing?.getAllResponseHeaders() ?? ''; }
    getResponseHeader(name) { return this._backing?.getResponseHeader(name) ?? null; }
  }

  const properties = ['readyState', 'status', 'statusText', 'response', 'responseText', 'responseURL', 'timeout', 'withCredentials', 'responseType'];
  const defaults = { readyState: UNSENT, status: 0, statusText: '', response: null, responseText: '', responseURL: '', timeout: 0, withCredentials: false, responseType: '' };
  for (const name of properties) {
    Object.defineProperty(ShimXMLHttpRequest.prototype, name, {
      get() { return this._backing ? this._backing[name] : (name === 'responseType' ? this._pendingResponseType : defaults[name]); },
      set(value) {
        if (name === 'responseType') this._pendingResponseType = value;
        if (this._backing) this._backing[name] = value;
      },
    });
  }
  const events = ['readystatechange', 'loadstart', 'progress', 'load', 'loadend', 'error', 'abort', 'timeout'];
  for (const name of events) {
    const property = `on${name}`;
    Object.defineProperty(ShimXMLHttpRequest.prototype, property, {
      get() { return this._backing ? this._backing[property] : this._pendingProperties.get(property); },
      set(value) {
        this._pendingProperties.set(property, value);
        if (this._backing) this._backing[property] = value;
      },
    });
  }
  ShimXMLHttpRequest.UNSENT = UNSENT;
  ShimXMLHttpRequest.OPENED = OPENED;
  ShimXMLHttpRequest.HEADERS_RECEIVED = HEADERS_RECEIVED;
  ShimXMLHttpRequest.LOADING = LOADING;
  ShimXMLHttpRequest.DONE = DONE;
  return ShimXMLHttpRequest;
}
