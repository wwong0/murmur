// public/lib/room-client.mjs
//
// The browser side of the room transport. Connect, join, send, subscribe by
// message type, and correlate a request with its reply.
//
// Two things in here are not conveniences and must not be refactored as such:
//
//  1. It stamps its own send and receive times AT THE WIRE.
//     Moving either stamp to where a caller would naturally take it puts the
//     event loop, JSON.parse and every subscriber for that type inside the
//     clock's offset estimate — as a one-directional bias, so averaging more
//     samples will not remove it.
//
//  2. It reports gaps in the room's order and does not repair them.
//     Report, do not repair: no buffering, no replay, no requesting what was
//     missed. Resuming is not this file's job.
//
// Constraints: under public/lib/, so it must never touch the DOM or read the
// page's address. Every piece of configuration arrives as an argument, which
// is what let the page be rewritten in React with this file unedited.

import {
  ADDR_ROOM,
  ADDR_SERVER,
  ERROR_CODES,
  TYPE_JOINED,
  TYPE_ERROR,
  TYPE_PRESENCE,
  CLOSE_SUPERSEDED,
  TYPE_ECHO,
  buildClientEnvelope,
  buildJoinEnvelope,
  buildNameEnvelope,
  buildChatEnvelope,
  readBody,
} from './envelope.mjs';

/**
 * The client's timebase. Matches the server's style deliberately: the offset
 * arithmetic works with any consistent clock, but matching makes the measured
 * offset a small number a human or an assertion can sanity-check rather than
 * one dominated by "time since page load".
 */
function clientNow() {
  return performance.timeOrigin + performance.now();
}

const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/**
 * NOT budgets. The retry budget for a `tab-taken` refusal comes from the
 * refusal itself, because the server is the only party that
 * knows its own liveness interval.
 *
 * These two are the guard that keeps the "never retry forever" promise when
 * that number cannot be trusted: a refusal carrying no time at all (an older
 * or foreign server), and one carrying an absurd one. Neither models any
 * particular liveness interval, and neither should be read as one.
 */
const FALLBACK_RETRY_BUDGET_MS = 5000;
const MAX_RETRY_BUDGET_MS = 60000;

/**
 * @param {object} config
 * @param {string} config.url          websocket url, e.g. ws://127.0.0.1:8100/ws
 * @param {string} config.room
 * @param {string} config.tabId        this tab's label; unique within the room, and published in every roster
 * @param {'host'|'viewer'} config.role
 * @param {Function} [config.WebSocketImpl] injected so the protocol check can drive this from Node
 * @param {boolean} [config.autoReconnect]  default true
 * @param {string} [config.name]       the member's name; every join carries the current one
 */
export function createRoomClient(config) {
  const {
    url,
    room,
    tabId,
    role,
    WebSocketImpl = globalThis.WebSocket,
    autoReconnect = true,
    name: configuredName,
  } = config;

  /** @type {Map<string, Set<Function>>} envelope type -> handlers */
  const typeHandlers = new Map();
  /** @type {Map<string, Set<Function>>} lifecycle event -> handlers */
  const eventHandlers = new Map();
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any, t1: number, to: string}>} */
  const pending = new Map();

  const state = {
    ws: /** @type {any} */ (null),
    clientId: /** @type {string|null} */ (null),
    roster: /** @type {object[]} */ ([]),
    /**
     * The reclaim secret from the most recent `joined`. In memory only, for
     * the life of the page, and never handed to a subscriber
     * or placed in any envelope but a `join`.
     *
     * REPLACE it on every `joined`; never accumulate. A reclaim mints a new
     * member, so a client still holding its first secret is presenting a
     * credential for a membership that no longer exists and its next reconnect
     * is refused. This is the half of rotation the client owns.
     */
    secret: /** @type {string|null} */ (null),
    /**
     * The role this client actually holds, read back from `joined` rather than
     * assumed from the configured one.
     */
    role: /** @type {'host'|'viewer'} */ (role),
    /**
     * When the current run of `tab-taken` refusals should stop, in this
     * client's timebase; null between runs.
     *
     * ANCHOR ON THE FIRST REFUSAL of a run and never extend it. Against a live
     * holder each later refusal reports a figure that does not shrink, so
     * re-anchoring pushes the deadline forward every attempt and retries
     * forever.
     */
    retryDeadline: /** @type {number|null} */ (null),
    /** The budget that produced it, kept only so subscribers can be told. */
    retryBudgetMs: /** @type {number|null} */ (null),
    /**
     * The last room-scoped `seq` observed. Deliberately survives a reconnect —
     * it is the only thing that makes the gap after one detectable.
     */
    lastSeq: /** @type {number|null} */ (null),
    connected: false,
    joined: false,
    closing: false,
    backoffMs: BACKOFF_START_MS,
    nextId: 0,
    /** The current name, carried by every join; null when none. */
    name: /** @type {string|null} */ (typeof configuredName === 'string' && configuredName.length > 0 ? configuredName : null),
    /** The id of the latest `name` sent, so its refusal can be told from any other error. */
    nameId: /** @type {string|null} */ (null),
  };

  function ownRosterName() {
    const mine = state.roster.find((m) => m.clientId === state.clientId);
    return mine && typeof mine.name === 'string' ? mine.name : null;
  }

  function sendName() {
    const id = `m-${state.nextId++}`;
    state.nameId = id;
    writeEnvelope(buildNameEnvelope({ id, name: state.name }));
    return id;
  }

  /** Set the name: it rides the next join, and goes to the server now if joined. */
  function setName(name) {
    state.name = typeof name === 'string' && name.length > 0 ? name : null;
    return state.joined && state.name !== null ? sendName() : null;
  }

  /** Send a chat message to the room; nothing is sent before the join. */
  function sendChat(text) {
    if (!state.joined) return null;
    const id = `m-${state.nextId++}`;
    writeEnvelope(buildChatEnvelope({ id, text }));
    return id;
  }

  function emitEvent(name, data) {
    const set = eventHandlers.get(name);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(data);
      } catch (err) {
        // A broken subscriber must not take the transport down with it.
        emitEvent('subscriber-error', { name, error: err });
      }
    }
  }

  function dispatch(env) {
    const set = typeHandlers.get(env.type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(env);
      } catch (err) {
        emitEvent('subscriber-error', { name: env.type, error: err });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Write an envelope and return the time it went out.
   *
   * `t1` is taken after serialisation and immediately before the write, so it
   * measures the moment the bytes were handed to the socket rather than the
   * moment the caller decided to send. Same rule as the server's `ts.send`,
   * for the same reason.
   */
  function writeEnvelope(env) {
    const ws = state.ws;
    if (!ws || ws.readyState !== 1) return null;
    const text = JSON.stringify(env);
    const t1 = clientNow();
    ws.send(text);
    return t1;
  }

  /**
   * Fire-and-forget send. `to` defaults to the room.
   * @param {{type: string, to?: string, id?: string, replyTo?: string, payload?: unknown}} fields
   */
  function send(fields) {
    const env = buildClientEnvelope({ to: ADDR_ROOM, ...fields });
    writeEnvelope(env);
    return env;
  }

  /**
   * Send and wait for the envelope whose `replyTo` matches this call's `id`
   * AND whose `from` is the party the request went to.
   *
   * Correlation is on `id` alone and never on `type`, so a second envelope of
   * the same type cannot resolve the wrong call.
   *
   * THE ADDRESS IS HALF THE CORRELATION KEY. Ids are
   * sequential, and the server relays any directed envelope between members
   * with `type` and `replyTo` intact, so `replyTo` alone lets any member in the
   * room resolve any other member's outstanding call with an exchange that
   * never happened. That is not a nuisance for the clock: its probe is a
   * request, min-delay selection actively prefers a forged sample because a
   * forger can make the round trip look as short as it likes, and the
   * corruption is one-directional so averaging cannot remove it.
   *
   * Checking `from` is sufficient because the server owns that field — it
   * overwrites it from its record of the connection and never derives it from
   * client input — so no member can claim to be another member or to be
   * `"server"`. Unguessable ids would be a second, weaker defence against a
   * threat this one already closes.
   *
   * `to` IS A PARAMETER, and that is the point. The room's time reference is
   * the server today, and if it moves to the host tab the probe becomes a
   * request addressed to a member instead of to `"server"` — with no change to this
   * module and none to the server.
   *
   * @param {{type: string, to?: string, payload?: unknown, timeoutMs?: number}} fields
   * @returns {Promise<object>} the reply envelope, carrying `local` timestamps
   */
  function request({ type, to = ADDR_SERVER, payload, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    const id = `m-${state.nextId++}`;
    const env = buildClientEnvelope({ type, to, id, payload });
    return new Promise((resolve, reject) => {
      const t1 = writeEnvelope(env);
      if (t1 === null) {
        reject(new Error('room-client: socket is not open'));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`room-client: request "${type}" (${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer === 'object' && timer.unref) timer.unref();
      pending.set(id, { resolve, reject, timer, t1, to });
    });
  }

  /** The round-trip probe the clock builds on. Returns the reply, timestamps attached. */
  function echo(timeoutMs) {
    return request({ type: TYPE_ECHO, to: ADDR_SERVER, timeoutMs });
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  function handleMessage(raw) {
    // T4, FIRST. Before JSON.parse, before the gap check, before any
    // subscriber runs. Everything after this line is work whose duration must
    // not enter the clock's estimate, and the only way to guarantee that is to
    // have already recorded the time.
    const t4 = clientNow();

    let env;
    try {
      env = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      emitEvent('protocol-error', { reason: 'server sent unparseable JSON' });
      return;
    }

    const awaiting = env.replyTo !== undefined ? pending.get(env.replyTo) : undefined;
    // Both halves of the key, or it resolves nothing. See `request`.
    const correlated = awaiting && env.from === awaiting.to ? awaiting : undefined;

    // Local-only. Never transmitted, and named so that a reader who sees it in
    // a log knows it did not come off the wire.
    //
    // `t1` is attached only to the envelope that genuinely answers the call:
    // pairing this client's send time with a stranger's message would
    // manufacture exactly the sample the check above exists to refuse.
    env.local = { t1: correlated ? correlated.t1 : null, t4 };

    if (env.type === TYPE_JOINED) {
      applyJoined(env);
    } else if (env.type === TYPE_ERROR && !state.joined) {
      // An error arriving on a connection that has not joined is a refused
      // join. Whatever code it carries, it is handled — see there.
      applyJoinRefusal(env);
    } else if (env.seq !== null && env.seq !== undefined) {
      checkOrder(env.seq);
    }
    // The roster is the latest one the server sent, not the join snapshot: a
    // host resolves a later joiner's tag from it.
    // Only the server's own presence counts — a member can relay one.
    if (env.type === TYPE_PRESENCE && env.from === ADDR_SERVER) {
      const roster = readBody(env).roster;
      if (Array.isArray(roster)) state.roster = roster;
    }
    // A refused rename must not be replayed by the next join.
    if (env.type === TYPE_ERROR && state.joined && env.from === ADDR_SERVER
      && env.replyTo !== undefined && env.replyTo === state.nameId) {
      state.nameId = null;
      state.name = ownRosterName();
    }

    // Subscribers run BEFORE the request promise resolves, deliberately. It
    // makes the "subscriber work does not enter the sample" guarantee
    // load-bearing rather than incidental: a slow handler for the reply type
    // delays the resolution and still cannot move `t4`, because `t4` was taken
    // above.
    dispatch(env);

    if (correlated) {
      pending.delete(env.replyTo);
      clearTimeout(correlated.timer);
      correlated.resolve(env);
      return;
    }
    // It named a live call and came from somebody else. Reported rather than
    // dropped: the call it aimed at is still outstanding and will time out on
    // its own, and a page that never hears about this cannot tell a member
    // sending rubbish from one sending it deliberately.
    if (awaiting) {
      emitEvent('uncorrelated-reply', { replyTo: env.replyTo, from: env.from, expectedFrom: awaiting.to, type: env.type });
    }
  }

  /**
   * The room's order is gapless within one connection. Across a reconnect it
   * is not, by construction — a reconnecting client is a new `clientId` and is
   * promised no continuity — which is exactly why the hole has to be reported
   * rather than assumed absent.
   */
  function checkOrder(seq) {
    if (state.lastSeq !== null && seq !== state.lastSeq + 1) {
      emitEvent('gap', { expected: state.lastSeq + 1, actual: seq });
    }
    state.lastSeq = seq;
  }

  function applyJoined(env) {
    const body = readBody(env);
    state.clientId = body.clientId;
    state.roster = body.roster;
    state.joined = true;
    state.backoffMs = BACKOFF_START_MS;
    // Replace, do not keep. See state.secret.
    state.secret = typeof body.secret === 'string' ? body.secret : null;
    // The role the server gave this membership, taken from the roster entry it
    // just sent for this very clientId rather than from the role we asked for.
    const mine = (body.roster ?? []).find((m) => m.clientId === body.clientId);
    state.role = mine ? mine.role : role;
    // A join succeeded, so any run of refusals is over and the next one anchors
    // a fresh deadline.
    state.retryDeadline = null;
    state.retryBudgetMs = null;

    // A rejoin whose reported room counter has moved past what this client
    // last saw means room-scoped messages were emitted while it was away.
    if (state.lastSeq !== null && body.seq > state.lastSeq) {
      emitEvent('gap', { expected: state.lastSeq + 1, actual: body.seq });
    }
    state.lastSeq = body.seq;

    // No `secret` in here. It is not a subscriber's business and putting it in
    // an event is how it ends up in somebody's log line.
    emitEvent('joined', {
      clientId: body.clientId,
      roster: body.roster,
      role: state.role,
      seq: body.seq,
      serverTime: body.serverTime,
    });

    // A reclaim reads no name from the join, so a name the server does not hold is sent now.
    if (state.name !== null && state.name !== ownRosterName()) sendName();
  }

  /**
   * Decide what to do about a refused join.
   *
   * TERMINAL BY CONSTRUCTION. `tab-taken` is the one
   * code carrying a retry policy; a refusal that does not match it stops the
   * client and is reported, whatever it says. The shape matters more than the
   * behaviour of any one code: an enumeration of handled codes falls out of
   * date silently, and the client that reaches the end of one sits connected,
   * unjoined and quiet forever while the page still reads *connected*.
   *
   * `tab-taken` is retried on the existing backoff until the time the refusal
   * reported has passed, because the label is often this client's own dying
   * connection that the server has not buried yet — the ordinary shape of a
   * host reloading its page. Nothing else frees itself by waiting.
   */
  function applyJoinRefusal(env) {
    const body = readBody(env);
    const code = body && body.code;

    if (code !== ERROR_CODES.TAB_TAKEN) {
      stopRefused(code, body && body.detail, body && body.releaseWithinMs);
      return;
    }

    if (state.retryDeadline === null) {
      const reported = body.releaseWithinMs;
      const budget =
        typeof reported === 'number' && Number.isFinite(reported) && reported >= 0
          ? Math.min(reported, MAX_RETRY_BUDGET_MS)
          : FALLBACK_RETRY_BUDGET_MS;
      state.retryBudgetMs = budget;
      state.retryDeadline = clientNow() + budget;
    }

    const remaining = state.retryDeadline - clientNow();
    // Retry while ANY of the reported window is left, so the last attempt lands
    // after it rather than before. Stopping short of the deadline would give up
    // in the exact moment the name became free, which is the whole failure this
    // budget exists to avoid.
    if (!autoReconnect || remaining <= 0) {
      stopRefused(code, body.detail, body.releaseWithinMs);
      return;
    }

    emitEvent('refused-retrying', {
      code,
      detail: body.detail,
      releaseWithinMs: body.releaseWithinMs,
      remainingMs: remaining,
      budgetMs: state.retryBudgetMs,
    });
    // Closing is what puts this back on the existing backoff: `onClose` sees an
    // ordinary close and schedules the reconnect, which rejoins.
    if (state.ws) state.ws.close();
  }

  /** Give up on a refused join: tell the subscribers, and do not come back. */
  function stopRefused(code, detail, releaseWithinMs) {
    const budgetMs = state.retryBudgetMs;
    state.retryDeadline = null;
    state.retryBudgetMs = null;
    state.closing = true;
    emitEvent('refused', { code, detail, releaseWithinMs, budgetMs });
    if (state.ws) state.ws.close();
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  function connect() {
    state.closing = false;
    const ws = new WebSocketImpl(url);
    state.ws = ws;

    const onOpen = () => {
      state.connected = true;
      emitEvent('status', { connected: true });
      // Present the retained secret: it is what lets the server recognise a
      // returning tab rather than refusing it behind the ghost of its own
      // previous connection. A first join has none and sends none.
      //
      // `tabId` and `role` still go out, but on a reclaim the server reads
      // neither — only when this turns out to be a new membership after all.
      writeEnvelope(buildJoinEnvelope({ room, tabId, role, secret: state.secret ?? undefined, name: state.name ?? undefined }));
    };
    const onMessage = (ev) => handleMessage(ev.data !== undefined ? ev.data : ev);
    const onClose = (ev) => {
      const code = ev && typeof ev.code === 'number' ? ev.code : null;
      state.connected = false;
      state.joined = false;
      state.clientId = null;

      // The one close that must NOT be retried: a newer connection presenting
      // this membership's reclaim secret has taken its place. Honouring the
      // code is what makes this page stop cleanly and say why — rotation, not
      // this branch, is what makes a retry harmless.
      const superseded = code === CLOSE_SUPERSEDED;
      if (superseded) state.closing = true;

      emitEvent('status', { connected: false, code, superseded });
      failPending(superseded ? 'room-client: superseded by a newer connection' : 'room-client: connection closed');
      if (superseded) {
        emitEvent('superseded', { code });
        return;
      }
      if (autoReconnect && !state.closing) scheduleReconnect();
    };
    const onError = (err) => emitEvent('transport-error', { error: err });

    // Browser WebSocket and the `ws` package agree on addEventListener, so one
    // path covers both the page and the protocol check.
    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);
    return ws;
  }

  function failPending(message) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
  }

  function scheduleReconnect() {
    const delay = state.backoffMs;
    state.backoffMs = Math.min(state.backoffMs * 2, BACKOFF_MAX_MS);
    emitEvent('reconnecting', { inMs: delay });
    const timer = setTimeout(() => {
      if (!state.closing) connect();
    }, delay);
    if (typeof timer === 'object' && timer.unref) timer.unref();
  }

  function close() {
    state.closing = true;
    failPending('room-client: closed by caller');
    if (state.ws) state.ws.close();
  }

  return {
    connect,
    close,
    send,
    request,
    echo,
    setName,
    sendChat,

    /** Subscribe to envelopes by `type`. */
    on(type, fn) {
      if (!typeHandlers.has(type)) typeHandlers.set(type, new Set());
      typeHandlers.get(type).add(fn);
      return () => typeHandlers.get(type).delete(fn);
    },

    /**
     * Subscribe to a lifecycle event: `status`, `joined`, `reconnecting`,
     * `gap`, `refused`, `refused-retrying`, `superseded`,
     * `uncorrelated-reply`, `protocol-error`, `transport-error`,
     * `subscriber-error`.
     */
    onEvent(name, fn) {
      if (!eventHandlers.has(name)) eventHandlers.set(name, new Set());
      eventHandlers.get(name).add(fn);
      return () => eventHandlers.get(name).delete(fn);
    },

    get clientId() {
      return state.clientId;
    },
    /** The role this client actually holds, per the server. No `secret` getter, deliberately. */
    get role() {
      return state.role;
    },
    get roster() {
      return state.roster;
    },
    get name() {
      return state.name;
    },
    get lastSeq() {
      return state.lastSeq;
    },
    get isConnected() {
      return state.connected;
    },
    get isJoined() {
      return state.joined;
    },
  };
}
