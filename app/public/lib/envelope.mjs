// Shared wire constructors (D2/D3).

import { isFileIdentity, isValidHostName } from './title-fields.mjs';

/** Protocol version; checked on join (D2). */
export const PROTOCOL_VERSION = 1;

/** Reserved routing addresses; other addresses are client ids. */
export const ADDR_ROOM = 'room';
export const ADDR_SERVER = 'server';

/** Error codes shared by server and client (D2). */
export const ERROR_CODES = Object.freeze({
  VERSION_MISMATCH: 'version-mismatch',
  BAD_ENVELOPE: 'bad-envelope',
  NOT_JOINED: 'not-joined',
  ALREADY_JOINED: 'already-joined',
  HOST_TAKEN: 'host-taken',
  TAB_TAKEN: 'tab-taken',
  UNKNOWN_RECIPIENT: 'unknown-recipient',
  RATE_LIMITED: 'rate-limited',
});

/** Replaced membership close code (1b design.md D5). */
export const CLOSE_SUPERSEDED = 4000;

/** Fresh secret; it is emitted only in the directed joined envelope (1b D1). */
export function newReclaimSecret() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Types the server interprets or emits; all others relay blind. */
export const TYPE_JOIN = 'join';
export const TYPE_LEAVE = 'leave';
export const TYPE_ECHO = 'echo';
export const TYPE_ECHO_REPLY = 'echo-reply';
export const TYPE_NAME = 'name';
export const TYPE_CHAT = 'chat';
export const TYPE_JOINED = 'joined';
export const TYPE_PRESENCE = 'presence';
export const TYPE_ERROR = 'error';

/** Types only the server emits. A member's envelope of one is refused, never relayed (12a D5). */
export const SERVER_ONLY_TYPES = Object.freeze([
  TYPE_PRESENCE,
  TYPE_JOINED,
  TYPE_ERROR,
  TYPE_ECHO_REPLY,
]);

/** Fields overwritten from server connection state by relayEnvelope. */
export const SERVER_OWNED_FIELDS = Object.freeze(['room', 'from', 'seq', 'ts']);

// Client -> server. Correlation labels and payload are client-owned.

/** Build a client envelope (D2/D3). @param {{type: string, to: string, id?: string, replyTo?: string, payload?: unknown}} fields */
export function buildClientEnvelope({ type, to, id, replyTo, payload }) {
  const env = {
    v: PROTOCOL_VERSION,
    type,
    to,
    payload: payload === undefined ? {} : payload,
  };
  if (id !== undefined) env.id = id;
  if (replyTo !== undefined) env.replyTo = replyTo;
  return env;
}

/** Build join content; secret is the only reclaim field (1b D8/D10). */
export function buildJoinEnvelope({ room, tabId, role, secret, name }) {
  const body = { room, tabId, role };
  if (secret !== undefined) body.secret = secret;
  if (typeof name === 'string' && name.length > 0) body.name = name;
  return buildClientEnvelope({
    type: TYPE_JOIN,
    to: ADDR_SERVER,
    payload: body,
  });
}

/** Build a name change for the server. */
export function buildNameEnvelope({ id, name }) {
  return buildClientEnvelope({ type: TYPE_NAME, to: ADDR_SERVER, id, payload: { name } });
}

/** Build a chat message for the room. */
export function buildChatEnvelope({ id, text }) {
  return buildClientEnvelope({ type: TYPE_CHAT, to: ADDR_ROOM, id, payload: { text } });
}

/** Build a correlated round-trip probe. */
export function buildEchoEnvelope(id) {
  return buildClientEnvelope({ type: TYPE_ECHO, to: ADDR_SERVER, id });
}

export const TYPE_PLAYBACK_OPERATION = 'playback-operation';
export const TYPE_PLAYBACK_STATE_REQUEST = 'playback-state-request';
export const TYPE_PLAYBACK_STATE_ANSWER = 'playback-state-answer';

/** Build a room-scoped playback operation (D12). */
export function buildPlaybackOperationEnvelope(payload) {
  return buildClientEnvelope({ type: TYPE_PLAYBACK_OPERATION, to: ADDR_ROOM, payload });
}

/** Build a directed playback-state answer correlated to a request (D12). */
export function buildPlaybackStateAnswerEnvelope({ to, replyTo, payload }) {
  return buildClientEnvelope({ type: TYPE_PLAYBACK_STATE_ANSWER, to, replyTo, payload });
}

// T6 (design.md D5): a viewer's held-ahead report, relayed to the host over the
// room's own websocket — no server change (server/** carries no "payload").
export const TYPE_AHEAD = 'ahead';

export const TYPE_HOST_STATUS = 'host-status';

export function buildHostStatusEnvelope(status) {
  let payload;
  if (status.state === 'ready') {
    payload = { state: 'ready' };
    if (status.identity !== undefined) {
      if (!isFileIdentity(status.identity)) {
        throw new TypeError('ready host status identity is invalid');
      }
      payload.identity = status.identity;
      if (status.name !== undefined) {
        if (!isValidHostName(status.name)) throw new TypeError('ready host status name is invalid');
        payload.name = status.name;
      }
    } else if (status.name !== undefined) {
      throw new TypeError('ready host status name needs an identity');
    }
  }
  else if (status.state === 'preparing') payload = { state: 'preparing', fraction: status.fraction };
  else if (status.state === 'choosing') payload = { state: 'choosing' };
  else throw new TypeError(`invalid host status state: ${status.state}`);
  return buildClientEnvelope({ type: TYPE_HOST_STATUS, to: ADDR_ROOM, payload });
}

export function readHostStatus(env) {
  if (env === null || typeof env !== 'object') return null;
  if (typeof env.from !== 'string' || env.from.length === 0) return null;
  const body = env.payload;
  if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) return null;
  const keys = Object.keys(body);
  const only = (...names) => keys.length === names.length && names.every((name) => keys.includes(name));
  if (body.state === 'ready') {
    if (only('state')) return { from: env.from, state: 'ready', fraction: null };
    const named = only('state', 'identity', 'name');
    if ((named || only('state', 'identity'))
      && isFileIdentity(body.identity)
      && (!named || isValidHostName(body.name))) {
      return {
        from: env.from, state: 'ready', fraction: null, identity: body.identity,
        ...(named ? { name: body.name } : {}),
      };
    }
  }
  if (body.state === 'choosing' && only('state')) return { from: env.from, state: 'choosing', fraction: null };
  if (body.state === 'preparing' && only('state', 'fraction')
    && typeof body.fraction === 'number' && Number.isFinite(body.fraction) && body.fraction >= 0 && body.fraction <= 1) {
    return { from: env.from, state: 'preparing', fraction: body.fraction };
  }
  return null;
}

/** Build a viewer's held-ahead report, addressed to one member (the host). */
export function buildAheadEnvelope({ to, lineage, version, heldAheadMs }) {
  return buildClientEnvelope({ type: TYPE_AHEAD, to, payload: { lineage, version, heldAheadMs } });
}

/** Read a relayed `ahead` envelope; `null` on any malformed field. */
export function readAheadReport(env) {
  if (env === null || typeof env !== 'object') return null;
  if (typeof env.from !== 'string' || env.from.length === 0) return null;
  const body = env.payload;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof body.lineage !== 'string' || body.lineage.length === 0) return null;
  if (!Number.isInteger(body.version)) return null;
  if (typeof body.heldAheadMs !== 'number' || !Number.isFinite(body.heldAheadMs) || body.heldAheadMs < 0) return null;
  return { from: env.from, lineage: body.lineage, version: body.version, heldAheadMs: body.heldAheadMs };
}

// Direction-aware structural validation; payload meaning belongs to consumers.

/** Return `{ok}` or `{ok:false, reason}` for client envelopes. */
export function validateClientEnvelope(env) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return { ok: false, reason: 'envelope must be a JSON object' };
  }
  const e = /** @type {Record<string, unknown>} */ (env);
  if (typeof e.type !== 'string' || e.type.length === 0) {
    return { ok: false, reason: 'missing or empty "type"' };
  }
  if (typeof e.to !== 'string' || e.to.length === 0) {
    return { ok: false, reason: 'missing or empty "to"' };
  }
  if (!('payload' in e) || e.payload === undefined) {
    return { ok: false, reason: 'missing "payload"' };
  }
  if (e.id !== undefined && typeof e.id !== 'string') {
    return { ok: false, reason: '"id" must be a string when present' };
  }
  if (e.replyTo !== undefined && typeof e.replyTo !== 'string') {
    return { ok: false, reason: '"replyTo" must be a string when present' };
  }
  return { ok: true };
}

/** Confirm server-owned routing and timestamps are present. */
export function validateServerEnvelope(env) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return { ok: false, reason: 'envelope must be a JSON object' };
  }
  const e = /** @type {Record<string, unknown>} */ (env);
  if (e.v !== PROTOCOL_VERSION) return { ok: false, reason: `unexpected version ${String(e.v)}` };
  if (typeof e.type !== 'string' || e.type.length === 0) return { ok: false, reason: 'missing "type"' };
  if (typeof e.room !== 'string') return { ok: false, reason: 'missing "room"' };
  if (typeof e.from !== 'string' || e.from.length === 0) return { ok: false, reason: 'missing "from"' };
  if (typeof e.to !== 'string' || e.to.length === 0) return { ok: false, reason: 'missing "to"' };
  if (e.seq !== null && !Number.isInteger(e.seq)) return { ok: false, reason: '"seq" must be an integer or null' };
  if (e.ts === null || typeof e.ts !== 'object') return { ok: false, reason: 'missing "ts"' };
  const ts = /** @type {Record<string, unknown>} */ (e.ts);
  if (typeof ts.recv !== 'number' || typeof ts.send !== 'number') {
    return { ok: false, reason: '"ts" must carry numeric recv and send' };
  }
  if (!('payload' in e)) return { ok: false, reason: 'missing "payload"' };
  return { ok: true };
}

// Server -> client. Constructors leave ts.send at 0; send stamps it late (D6).

/** @typedef {{room:string, to:string, seq?:number|null, recv:number, from?:string, id?:string, replyTo?:string}} Routing */

/** Shared server envelope skeleton; send timestamp remains deferred. */
function serverEnvelope(routing, type, body) {
  const env = {
    v: PROTOCOL_VERSION,
    type,
    room: routing.room,
    from: routing.from === undefined ? ADDR_SERVER : routing.from,
    to: routing.to,
    seq: routing.seq === undefined ? null : routing.seq,
    ts: { recv: routing.recv, send: 0 },
    payload: body,
  };
  if (routing.id !== undefined) env.id = routing.id;
  if (routing.replyTo !== undefined) env.replyTo = routing.replyTo;
  return env;
}

/** Spread first, then overwrite server-owned routing fields (D3). */
export function relayEnvelope(clientEnv, routing) {
  return {
    ...clientEnv,
    v: PROTOCOL_VERSION,
    room: routing.room,
    from: routing.from,
    to: routing.to,
    seq: routing.seq === undefined ? null : routing.seq,
    ts: { recv: routing.recv, send: 0 },
  };
}

/** Directed join acknowledgement; the secret appears only here (1b D1/D12). */
export function makeJoined(routing, { clientId, roster, roomSeq, serverTime, secret }) {
  return serverEnvelope(routing, TYPE_JOINED, { clientId, roster, seq: roomSeq, serverTime, secret });
}

/** Emit the full roster for a membership change (D7). */
export function makePresence(routing, { event, member, roster }) {
  return serverEnvelope(routing, TYPE_PRESENCE, { event, member, roster });
}

/** Emit a non-closing refusal and optional reclaim release advice (1b D13). */
export function makeError(routing, { code, detail, expected, got, releaseWithinMs }) {
  const body = { code };
  if (detail !== undefined) body.detail = detail;
  if (expected !== undefined) body.expected = expected;
  if (got !== undefined) body.got = got;
  if (releaseWithinMs !== undefined) body.releaseWithinMs = releaseWithinMs;
  return serverEnvelope(routing, TYPE_ERROR, body);
}

/** Answer a round-trip probe; send time is stamped by the server helper. */
export function makeEchoReply(routing) {
  return serverEnvelope(routing, TYPE_ECHO_REPLY, {});
}

// Body readers. The server reads only join, name and chat, each through one of these.

export const NAME_MAX_CODE_POINTS = 32;
export const CHAT_MAX_CODE_POINTS = 500;

const FORBIDDEN_TEXT = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/** The one text rule for names and messages: the string, or null. Does not trim. */
export function readMemberText(value, maxCodePoints) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (FORBIDDEN_TEXT.test(value)) return null;
  if ([...value].length > maxCodePoints) return null;
  return value;
}

function readTrimmedName(value) {
  return typeof value === 'string' ? readMemberText(value.trim(), NAME_MAX_CODE_POINTS) : null;
}

function isPlainObject(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.getPrototypeOf(body) === Object.prototype;
}

/** Read a `name` body; other keys are ignored. */
export function readNameRequest(env) {
  const body = env.payload;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  const name = readTrimmedName(body.name);
  return name === null ? { ok: false } : { ok: true, name };
}

/** Read a `chat` body: only `text`, untrimmed. */
export function readChatMessage(env) {
  const body = env.payload;
  if (!isPlainObject(body)) return { ok: false };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'text') return { ok: false };
  const text = readMemberText(body.text, CHAT_MAX_CODE_POINTS);
  return text === null ? { ok: false } : { ok: true, text };
}

/** Read and validate join content; an unmatched secret is an ordinary join (1b D9). */
export function readJoinRequest(env) {
  const body = env.payload;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'join body must be an object' };
  }
  const b = /** @type {Record<string, unknown>} */ (body);
  if (typeof b.room !== 'string' || b.room.length === 0) {
    return { ok: false, reason: 'join needs a non-empty "room"' };
  }
  if (typeof b.tabId !== 'string' || b.tabId.length === 0) {
    return { ok: false, reason: 'join needs a non-empty "tabId"' };
  }
  if (b.role !== 'host' && b.role !== 'viewer') {
    return { ok: false, reason: 'join "role" must be "host" or "viewer"' };
  }
  if (b.secret !== undefined && (typeof b.secret !== 'string' || b.secret.length === 0)) {
    return { ok: false, reason: 'join "secret" must be a non-empty string when present' };
  }
  const name = readTrimmedName(b.name);
  return {
    ok: true, room: b.room, tabId: b.tabId, role: b.role, secret: b.secret,
    ...(name === null ? {} : { name }),
  };
}

/** Read any envelope body on the browser side. */
export function readBody(env) {
  return env.payload;
}
