// public/lib/envelope.mjs
//
// The wire format, shared verbatim by the room server and the browser bundle,
// so the two sides cannot disagree about the envelope shape.
//
// Two shapes, not one: a client supplies routing intent and content, and the
// server fills room, sender, sequence number and timestamps from its own
// record of the connection. This is also where EVERY server-originated
// envelope is constructed, which is what keeps `server/**` free of the content
// field's name — `scripts/check-structure.mjs` fails the build if it appears
// there. Reasoning for both: change 1 design.md D2 and D3.
//
// Constraints on this file: imported by Node AND by the browser bundle, so no
// `node:` builtins and no DOM.

/** Wire protocol version. Checked on `join` only (D2). Bump when a routing field changes meaning. */
export const PROTOCOL_VERSION = 1;

/** Reserved `to` / `from` addresses. Anything else is a clientId. */
export const ADDR_ROOM = 'room';
export const ADDR_SERVER = 'server';

/**
 * Every error code the server may emit. Here rather than in the server so both
 * sides can name them and a client can switch on a code rather than on prose.
 */
export const ERROR_CODES = Object.freeze({
  VERSION_MISMATCH: 'version-mismatch',
  BAD_ENVELOPE: 'bad-envelope',
  NOT_JOINED: 'not-joined',
  ALREADY_JOINED: 'already-joined',
  HOST_TAKEN: 'host-taken',
  TAB_TAKEN: 'tab-taken',
  UNKNOWN_RECIPIENT: 'unknown-recipient',
});

/**
 * Close code for a connection replaced by a newer one presenting that
 * membership's reclaim secret. It tells the replaced client it was replaced
 * rather than dropped, so it stops instead of retrying — it is not what makes
 * the reclaim loop impossible; secret rotation is (1b design.md D5).
 *
 * Shared constant rather than a bare 4000 on each side, because only one of
 * "replaced" and "network dropped" should be retried.
 */
export const CLOSE_SUPERSEDED = 4000;

/**
 * A fresh reclaim secret. Issued to every admitted member and returned only in
 * that member's directed `joined` reply (1b design.md D1).
 *
 * `getRandomValues` rather than `randomUUID`: it is unconditionally available
 * in both runtimes this module imports into, where `randomUUID` additionally
 * requires a secure context — which `http://127.0.0.1` happens to satisfy today
 * and a later origin might not.
 */
export function newReclaimSecret() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Protocol message types the server answers itself. Everything else is relayed blind. */
export const TYPE_JOIN = 'join';
export const TYPE_LEAVE = 'leave';
export const TYPE_ECHO = 'echo';
export const TYPE_ECHO_REPLY = 'echo-reply';
export const TYPE_JOINED = 'joined';
export const TYPE_PRESENCE = 'presence';
export const TYPE_ERROR = 'error';

/**
 * The routing fields the server fills from connection state. Reference list;
 * nothing imports it — `relayEnvelope` names these fields directly.
 */
export const SERVER_OWNED_FIELDS = Object.freeze(['room', 'from', 'seq', 'ts']);

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/**
 * Build the envelope a client puts on the wire: routing intent and content.
 *
 * `id` and `replyTo` are the client's own correlation labels and travel
 * untouched in both directions — the server must not renumber them, because
 * client B answers client A by echoing the `id` A chose.
 *
 * @param {{type: string, to: string, id?: string, replyTo?: string, payload?: unknown}} fields
 */
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

/**
 * Build the `join` request. Room, tab label and claimed role are content, not
 * routing: the server has no record of this connection yet, so this is the one
 * message whose body it must read.
 *
 * `secret` is omitted on a first join. When present it is the only one of the
 * four the server reads — a join whose secret matches a live membership
 * reclaims it and takes the label, join time and role from the membership
 * rather than from this message (1b design.md D8, D10).
 *
 * @param {{room: string, tabId: string, role: 'host'|'viewer', secret?: string}} fields
 */
export function buildJoinEnvelope({ room, tabId, role, secret }) {
  const body = { room, tabId, role };
  if (secret !== undefined) body.secret = secret;
  return buildClientEnvelope({
    type: TYPE_JOIN,
    to: ADDR_SERVER,
    payload: body,
  });
}

/** Build the round-trip probe. `id` is required — the reply is matched on it. */
export function buildEchoEnvelope(id) {
  return buildClientEnvelope({ type: TYPE_ECHO, to: ADDR_SERVER, id });
}

// ---------------------------------------------------------------------------
// Validation — direction aware, and it reports *why*
// ---------------------------------------------------------------------------

/**
 * `{ok: true}` or `{ok: false, reason}`. The reason rides along in the
 * `bad-envelope` error, so a client that sends rubbish is told what was wrong.
 *
 * Note what is NOT validated: the message body. Validating it would require
 * knowing what the type means, which is the knowledge the server is forbidden
 * to have.
 *
 * @param {unknown} env
 */
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

/**
 * The mirror check, used by the browser client and the protocol check to
 * confirm the server filled in everything it owns. Not used on the server's
 * own hot path — the server is the one producing these.
 *
 * @param {unknown} env
 */
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

// ---------------------------------------------------------------------------
// Server -> client
//
// Every constructor here leaves `ts.send` at 0. The server's single send
// helper stamps it immediately before the write, after all other work on the
// message (design.md D6) — DO NOT stamp it here, or queueing delay lands
// inside change 2's offset estimate.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Routing
 * @property {string} room    room name this connection belongs to
 * @property {string} to      clientId, "room", or "server"
 * @property {number|null} seq room-scoped order position, null when directed
 * @property {number} recv    server receive time that caused this message
 * @property {string} [from]  defaults to "server" for server-originated messages
 * @property {string} [id]
 * @property {string} [replyTo]
 */

/**
 * Shared skeleton. `ts.send` is a placeholder; see the note above.
 * @param {Routing} routing
 * @param {string} type
 * @param {unknown} body
 */
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

/**
 * Take a client's envelope and make it the server's. Every field the server
 * owns is overwritten from connection state; type, correlation labels and the
 * whole message body ride through on the spread, byte-identically, without
 * this function or its caller naming any of them.
 *
 * The spread-then-overwrite ORDER is load-bearing: whatever the client put in
 * `from`, `room`, `seq` or `ts` is copied and then immediately replaced by the
 * truth. Reorder it and a client can forge its own identity.
 *
 * @param {Record<string, unknown>} clientEnv  an envelope that has passed validateClientEnvelope
 * @param {Routing} routing
 */
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

/**
 * Acknowledge a join: who it is, who else is here, where the room's order
 * stands, and what time the room thinks it is.
 *
 * `seq` inside the body is the room's counter at the moment of the join, so
 * the next room-scoped envelope this client sees carries the following value.
 * The envelope's own `seq` is null — `joined` is directed and outside the
 * room's total order.
 *
 * This is the ONLY envelope the secret is ever written into (1b design.md
 * D1/D12), and `scripts/protocol-check.mjs` asserts that over every envelope
 * the server emits rather than over a list of types.
 *
 * @param {Routing} routing
 * @param {{clientId: string, roster: object[], roomSeq: number, serverTime: number, secret: string}} data
 */
export function makeJoined(routing, { clientId, roster, roomSeq, serverTime, secret }) {
  return serverEnvelope(routing, TYPE_JOINED, { clientId, roster, seq: roomSeq, serverTime, secret });
}

/**
 * Announce a membership change as the FULL roster, never a delta (design.md
 * D7): a client that maintains no incremental presence state cannot drift out
 * of agreement with the server about who is present.
 *
 * @param {Routing} routing
 * @param {{event: 'join'|'leave', member: object, roster: object[]}} data
 */
export function makePresence(routing, { event, member, roster }) {
  return serverEnvelope(routing, TYPE_PRESENCE, { event, member, roster });
}

/**
 * Refuse something, without closing anything.
 *
 * `releaseWithinMs` rides on a `tab-taken` refusal (1b design.md D13): the
 * maximum time the server would take to release that `tabId` if its holder
 * never answered another ping. The client waits that long, which makes its
 * budget correct at every liveness setting without it knowing which one it is
 * in. It is advice attached to a refusal already made, never part of the
 * reclaim decision — that is the secret and nothing else.
 *
 * @param {Routing} routing
 * @param {{code: string, detail?: string, expected?: unknown, got?: unknown, releaseWithinMs?: number}} data
 */
export function makeError(routing, { code, detail, expected, got, releaseWithinMs }) {
  const body = { code };
  if (detail !== undefined) body.detail = detail;
  if (expected !== undefined) body.expected = expected;
  if (got !== undefined) body.got = got;
  if (releaseWithinMs !== undefined) body.releaseWithinMs = releaseWithinMs;
  return serverEnvelope(routing, TYPE_ERROR, body);
}

/**
 * Answer a round-trip probe. Carries no data of its own — the sample lives
 * entirely in `ts`, and the client supplies its own two timestamps at the wire.
 *
 * @param {Routing} routing
 */
export function makeEchoReply(routing) {
  return serverEnvelope(routing, TYPE_ECHO_REPLY, {});
}

// ---------------------------------------------------------------------------
// Reading message bodies
//
// `join` is the one message whose content the server must read — it has no
// record of the connection yet. Reading it HERE, beside the constructor that
// wrote it, is what keeps `server/**` free of the content field's name. Read
// the secret in `server/room-server.mjs` instead and the build fails, which is
// the check doing its job (1b design.md D7).
//
// The browser-side reader below carries no such restriction: the prohibition
// is on the *server* interpreting content, not the client.
// ---------------------------------------------------------------------------

/**
 * Pull the join request's fields out, validated. Returns `{ok, room, tabId,
 * role, secret}` or `{ok: false, reason}`.
 *
 * `secret` is optional and `undefined` on a first join. A secret matching no
 * live member is NOT an error — the client presents its held secret on every
 * rejoin and cannot know whether its old membership still exists, so "matches
 * nothing" is the common path and is admitted as an ordinary join (1b
 * design.md D9). Only a malformed one is refused here.
 *
 * @param {{payload?: unknown}} env
 */
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
  return { ok: true, room: b.room, tabId: b.tabId, role: b.role, secret: b.secret };
}

/** The message body of any envelope. Browser side only. @param {{payload: unknown}} env */
export function readBody(env) {
  return env.payload;
}
