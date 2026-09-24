import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fromCore = (path) => new URL(`../../node_modules/p2p-media-loader-core/lib/${path}`, import.meta.url).href;
const { Request } = await import(fromCore('requests/request.js'));
const { HttpRequestExecutor } = await import(fromCore('http-loader.js'));
const { EventTarget } = await import(fromCore('utils/event-target.js'));
const { BandwidthCalculator } = await import(fromCore('bandwidth-calculator.js'));

export const coreFiles = {
  core: fileURLToPath(fromCore('core.js')),
  hybrid: fileURLToPath(fromCore('hybrid-loader.js')),
  container: fileURLToPath(fromCore('requests/request-container.js')),
  request: fileURLToPath(fromCore('requests/request.js')),
};

const playbackConfig = {
  highDemandTimeWindow: 15,
  httpDownloadTimeWindow: 3000,
  p2pDownloadTimeWindow: 6000,
};

function newSegment(runtimeId, url, byteRange) {
  const stream = { runtimeId: 'stream-1', type: 'main', index: '0', segments: new Map() };
  const segment = {
    runtimeId,
    externalId: Number(runtimeId.replace(/\D/g, '')) || 1,
    url,
    byteRange,
    startTime: 0,
    endTime: 4,
    stream,
  };
  stream.segments.set(runtimeId, segment);
  return segment;
}

export function createRig({ runtimeId = 'seg-1', url = new URL('../../public/room.html', import.meta.url).href, byteRange } = {}) {
  const eventTarget = new EventTarget();
  const requests = new Map();
  const core = {
    peerId: 'v1',
    mainStreamLoader: { requests: { requests } },
    secondaryStreamLoader: { requests: { requests: new Map() } },
  };
  const engine = {
    core,
    addEventListener: (name, listener) => eventTarget.addEventListener(name, listener),
    dispatch: (name, ...args) => eventTarget.dispatchEvent(name, ...args),
  };
  const segment = newSegment(runtimeId, url, byteRange);
  const rig = { engine, eventTarget, requests, segment, makeRequest };
  function makeRequest(target = segment) {
    const request = new Request(
      target,
      () => {},
      { all: new BandwidthCalculator(), http: new BandwidthCalculator() },
      { position: 0, rate: 1 },
      playbackConfig,
      eventTarget,
      'info-hash',
    );
    requests.set(target, request);
    return request;
  }
  rig.request = makeRequest();
  return rig;
}

export function response(bytes, { status = 200, headers = {} } = {}) {
  return new Response(new Uint8Array(bytes), { status, headers });
}

export async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

export function installWindow(fetch) {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const previous = globalThis.window;
  const timers = [];
  globalThis.window = {
    fetch,
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => {},
  };
  return {
    timers,
    restore() {
      if (hadWindow) globalThis.window = previous;
      else delete globalThis.window;
    },
  };
}

export async function executeHttp(rig, replies) {
  let call = 0;
  const windowState = installWindow(async () => replies[call++]);
  try {
    new HttpRequestExecutor(rig.request, { httpNotReceivingBytesTimeoutMs: undefined }, rig.eventTarget).execute();
    await flush();
  } finally {
    windowState.restore();
  }
}

export function packageVersion(packageName) {
  const packageUrl = new URL(`../../node_modules/${packageName}/package.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(packageUrl), 'utf8')).version;
}

export function fileText(path) {
  return readFileSync(path, 'utf8');
}

export { Request };
