// server/room-server.mjs
//
// One process, one origin (design.md D1): the room page, the pre-generated
// media, and the websocket endpoint all live on http://127.0.0.1:8100.
//
// THE INVARIANT THIS FILE IS BUILT ON: the server routes; it does not
// interpret. It reads `type` only far enough to tell its own protocol messages
// (join, leave, echo) from everything else. It reads message CONTENT for
// `join` and for nothing else, and even then through a named accessor in
// public/lib/envelope.mjs rather than a field access here — design.md I4
// narrows D3's prose to exactly this, and this file is the narrower statement.
//
// The invariant is defended structurally, not by good intentions: every
// envelope this file emits is constructed in envelope.mjs, and
// scripts/check-structure.mjs fails the build if this directory so much as
// names the content field. Changes 2, 5, 7a and 10 add message types without
// touching this file; if one needs to, that is a design failure to record.
//
// Node 24, ESM, node:http + node:fs + node:path + ws.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { classifyPath, countDelivered, createCounters } from './byte-accounting.mjs';

import {
  PROTOCOL_VERSION,
  ADDR_ROOM,
  ADDR_SERVER,
  ERROR_CODES,
  CLOSE_SUPERSEDED,
  TYPE_JOIN,
  TYPE_LEAVE,
  TYPE_ECHO,
  relayEnvelope,
  validateClientEnvelope,
  readJoinRequest,
  newReclaimSecret,
  makeJoined,
  makePresence,
  makeError,
  makeEchoReply,
} from '../public/lib/envelope.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8100;
// ONE named setting, not a fixed path (design.md D1): change 6 runs this in
// containers and change 11 relocates it again, and neither should have to edit
// a measured code path for a reason unrelated to what it measures.
const DEFAULT_MEDIA_DIR = path.resolve(APP_DIR, '..', 'step0', 'content');
// Settable at start because the protocol check must prove a dead connection is
// removed, and at the default that puts a multi-second floor on every run —
// which turns a check you run constantly into one you run occasionally (D8).
// The 5s default is sized against change 7a's saturated host; see 1b
// design.md, "Challenged and left standing", before shortening it.
const DEFAULT_LIVENESS_MS = 5000;

function normalizeTrackerUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || (!value.startsWith('ws://') && !value.startsWith('wss://'))) {
    throw new TypeError('trackerUrl must be a ws:// or wss:// URL');
  }
  return value;
}

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/mp4',
  '.mp4': 'video/mp4',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.map': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// The room clock
// ---------------------------------------------------------------------------

/**
 * The room's time reference: a millisecond float on a monotonic base, so it
 * does not step when NTP corrects the OS clock (design.md D6).
 *
 * NOT `Date.now()`. A wall-clock step shows up as a simultaneous jump in
 * apparent offset at every client at once — precisely the input change 2's
 * filter is meant to treat as suspicious. The reference is deliberately not
 * UTC; positions are expressed in the room's own timebase.
 */
function serverNow() {
  return performance.timeOrigin + performance.now();
}

// ---------------------------------------------------------------------------
// Rooms and members
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Member
 * @property {string} clientId    server-assigned, unique for this process
 * @property {string} tabId       client-chosen, stable across reconnects
 * @property {'host'|'viewer'} role
 * @property {number} joinedAt    room timebase
 * @property {string} secret      server-issued reclaim secret; see below
 * @property {import('ws').WebSocket} ws
 */

/**
 * @typedef {object} Room
 * @property {string} name
 * @property {number} seq         room-scoped total order counter
 * @property {Map<string, Member>} members
 */

function newClientId() {
  return `c-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * The public view of a member — what goes out in a roster. No socket, no
 * internals, and DELIBERATELY no `secret` (1b design.md D1).
 *
 * Everything in here is broadcast to every member on every join and leave.
 * That is why `tabId` cannot be what proves a returning tab is itself.
 */
function rosterEntry(member) {
  return { clientId: member.clientId, tabId: member.tabId, role: member.role, joinedAt: member.joinedAt };
}

/** Roster in join order, so every member renders the same list in the same order. */
function rosterOf(room) {
  return [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map(rosterEntry);
}

function findHost(room) {
  for (const member of room.members.values()) {
    if (member.role === 'host') return member;
  }
  return null;
}

/**
 * The membership a reclaim secret refers to, or null. THE ONE PLACE A SECRET
 * IS COMPARED — keep it that way (1b design.md D10). Keyed on the secret
 * alone; the `tabId` in the message is not consulted.
 */
function findBySecret(room, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  for (const member of room.members.values()) {
    if (member.secret === secret) return member;
  }
  return null;
}

/** The member holding a `tabId`, or null. Consulted only on the new-membership path. */
function findByTabId(room, tabId) {
  for (const member of room.members.values()) {
    if (member.tabId === tabId) return member;
  }
  return null;
}

/**
 * The longest this member could keep holding its `tabId` if its connection
 * never answered another ping (1b design.md D13). A `tab-taken` refusal
 * reports it; the refused client uses it as its retry budget.
 *
 * Read straight out of the state the sweep already maintains. NO PROBE, no
 * timer, no held reply — asserted by the protocol check.
 *
 * The sweep terminates a connection on the tick where it is awaiting a pong
 * and has already missed one, so the ticks left depend on where in that cycle
 * the holder sits:
 *
 *   awaiting a pong, already missed one  -> the next tick terminates      (1)
 *   awaiting a pong, none missed yet     -> one tick to miss, one to kill (2)
 *   not awaiting one (it just answered)  -> a tick to ping, then those two (3)
 *
 * Ticks are counted rather than measured because the next tick can be anywhere
 * from an instant to a full interval away, and this has to be an upper bound.
 * Deliberately a MULTIPLE OF `livenessMs`, never a constant — a constant is
 * right at one setting and wrong at every other, which is the fault D13 fixed.
 */
function msUntilNameReleased(member, livenessMs) {
  const state = member.ws && member.ws._connState;
  // No connection state means the sweep does not track it, so nothing here can
  // predict its removal. Report the full window rather than zero — a client
  // that stops early is the failure this figure exists to prevent.
  if (!state) return livenessMs * 3;
  const ticks = state.awaitingPong ? Math.max(1, 2 - state.missedPings) : 3;
  return ticks * livenessMs;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Start the room server. Exported rather than run on import so
 * scripts/protocol-check.mjs can bring one up on an ephemeral port with a
 * short liveness interval and a temporary media root, in-process, without
 * spawning anything.
 *
 * @param {{port?: number, host?: string, mediaDir?: string, livenessMs?: number, quiet?: boolean, delivery?: 'host'|'http', iceServers?: object[], trackerUrl?: string|null}} [opts]
 */
export function startRoomServer(opts = {}) {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  // Resolved once, at startup, so every later read is a plain path join.
  const mediaDir = path.resolve(opts.mediaDir ?? DEFAULT_MEDIA_DIR);
  const livenessMs = opts.livenessMs ?? DEFAULT_LIVENESS_MS;
  const quiet = opts.quiet ?? false;
  const delivery = opts.delivery ?? 'host';
  if (delivery !== 'host' && delivery !== 'http') {
    throw new TypeError(`delivery must be "host" or "http", got ${JSON.stringify(delivery)}`);
  }
  const trackerUrl = normalizeTrackerUrl(opts.trackerUrl);
  if (trackerUrl !== null && delivery === 'http') {
    throw new TypeError('APP_TRACKER_URL is set but APP_DELIVERY is "http"; peer exchange requires delivery "host"');
  }
  const iceServers = opts.iceServers ?? [];
  if (!Array.isArray(iceServers)) throw new TypeError('iceServers must be an array');

  const log = quiet ? () => {} : (...args) => console.log('[room]', ...args);
  const counters = createCounters();
  const socketStates = new WeakMap();
  let nextSocketId = 1;

  function responsePosition(socket) {
    if (!socket) return { socketId: null, responseIndex: null };
    let state = socketStates.get(socket);
    if (!state) {
      state = { socketId: nextSocketId++, responseIndex: 0 };
      socketStates.set(socket, state);
    }
    state.responseIndex += 1;
    return { socketId: state.socketId, responseIndex: state.responseIndex };
  }

  /** @type {Map<string, Room>} */
  const rooms = new Map();

  function getOrCreateRoom(name) {
    let room = rooms.get(name);
    if (!room) {
      room = { name, seq: 0, members: new Map() };
      rooms.set(name, room);
      log(`room created: ${name}`);
    }
    return room;
  }

  /** Rooms are reaped when the last member goes, so the map cannot grow without bound. */
  function reapIfEmpty(room) {
    if (room.members.size === 0) {
      rooms.delete(room.name);
      log(`room reaped: ${room.name}`);
    }
  }

  // -------------------------------------------------------------------------
  // The one place anything is written to a socket
  //
  // `ts.send` is stamped HERE, immediately before the write and after every
  // other piece of work on this message (design.md D6). Stamp it any earlier
  // and queueing delay lands inside change 2's offset estimate, where it is
  // indistinguishable from an asymmetric network path.
  // -------------------------------------------------------------------------
  function emit(ws, env) {
    if (!ws || ws.readyState !== ws.OPEN) return false;
    env.ts.send = serverNow();
    try {
      ws.send(JSON.stringify(env));
      return true;
    } catch (err) {
      log(`send failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Deliver a room-scoped envelope to every member INCLUDING the sender
   * (design.md D4) — change 5 needs the sender to learn the `seq` its own
   * action was assigned.
   *
   * The envelope object is reused across members deliberately: each write gets
   * its own `ts.send` stamp from `emit`, which is what makes each recipient's
   * timestamp true for its own socket.
   */
  function broadcast(room, env) {
    for (const member of room.members.values()) emit(member.ws, env);
  }

  /** Routing context for a message the server originates towards one connection. */
  function directedRouting(conn, recv, extra = {}) {
    return { room: conn.roomName ?? '', to: conn.clientId ?? ADDR_SERVER, seq: null, recv, ...extra };
  }

  function refuse(ws, conn, recv, code, detail, extra = {}) {
    emit(ws, makeError(directedRouting(conn, recv), { code, detail, ...extra }));
  }

  // -------------------------------------------------------------------------
  // HTTP: pages, bundle, media
  // -------------------------------------------------------------------------

  /**
   * The single point at which a response finishes, successfully or not.
   *
   * Change 1 builds no accounting; change 6 owns it. What exists here is the
   * SHAPE change 6 needs, and the shape is dictated by CONSTRAINTS.md: count
   * DELIVERED bytes from a socket `bytesWritten` delta on close, clamped to
   * the expected size, and identify the client from a HEADER, never the URL.
   * Read both of those rules there before changing this function.
   */
  function completeResponse(res, ctx) {
    res.on('close', () => {
      const result = ctx.socket
        ? countDelivered({
            socketBytesAtStart: ctx.socketBytesAtStart,
            socketBytesAtEnd: ctx.socket.bytesWritten,
            expectedBytes: ctx.expectedBytes,
            writableFinished: res.writableFinished,
          })
        : { delivered: 0, waste: 0, aborted: !res.writableFinished };
      counters.record({
        ...ctx,
        ...result,
        socketBytesAtEnd: ctx.socket ? ctx.socket.bytesWritten : ctx.socketBytesAtStart,
      });
      if (!ctx.socket) counters.incrementResponsesWithNoSocket();
    });
  }

  function sendFile(req, res, absPath, clientTag) {
    let stat;
    try {
      stat = fs.statSync(absPath);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const type = MIME[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
    const socket = res.socket;
    const position = responsePosition(socket);
    const originResponseId = position.socketId === null
      ? null
      : `${position.socketId}:${position.responseIndex}`;
    const headers = {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    };
    if (originResponseId !== null) headers['X-App-Response-Id'] = originResponseId;
    res.writeHead(200, headers);

    // Flush the response headers before recording the body baseline. Otherwise
    // keep-alive header bytes can be attributed to the following body.
    res.flushHeaders();
    completeResponse(res, {
      clientTag,
      urlPath: req.url,
      kind: classifyPath(req.url),
      expectedBytes: stat.size,
      socket,
      socketId: position.socketId,
      responseIndex: position.responseIndex,
      originResponseId,
      socketBytesAtStart: socket ? socket.bytesWritten : 0,
    });

    const stream = fs.createReadStream(absPath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  /**
   * Resolve a URL path under `root`, refusing anything that escapes it.
   *
   * Containment is checked on the RESOLVED path, so there is nothing left to
   * pattern-match against.
   *
   * DO NOT add a normalise step before `path.resolve`. Normalising first
   * collapses a leading `..` against the URL root and hands this function an
   * already-innocent path: the traversal is silently rewritten into a
   * legitimate lookup rather than refused, and the guard becomes unreachable
   * and therefore untestable. That was change 1's I3 defect.
   */
  function resolveWithin(root, urlPath) {
    let decoded;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.indexOf('\0') !== -1) return null;
    const candidate = path.resolve(root, `.${decoded}`);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (candidate !== root && !candidate.startsWith(rootWithSep)) return null;
    return candidate;
  }

  const httpServer = http.createServer((req, res) => {
    // The RAW request target, split at the query string and otherwise
    // untouched. Deliberately NOT `new URL()`: the WHATWG parser resolves dot
    // segments, including percent-encoded ones, so the guard below would never
    // be reached and could rot undetected (design.md I3).
    const queryAt = req.url.indexOf('?');
    let pathname = queryAt === -1 ? req.url : req.url.slice(0, queryAt);

    // Per-request client identity for change 6's attribution, taken from a
    // header so media URLs stay identical for every peer.
    const clientTag = typeof req.headers['x-app-tab'] === 'string' ? req.headers['x-app-tab'] : null;

    if (req.method === 'GET' && pathname === '/harness/counters') {
      counters.incrementSnapshotRequests();
      const body = JSON.stringify({
        atMs: Date.now(),
        atIso: new Date().toISOString(),
        serverNowMs: serverNow(),
        uptimeMs: process.uptime() * 1000,
        counters: counters.snapshot(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && pathname === '/app-settings') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ delivery, iceServers, trackerUrl }));
      return;
    }

    if (pathname.startsWith('/media/')) {
      const abs = resolveWithin(mediaDir, pathname.slice('/media'.length));
      if (!abs) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      sendFile(req, res, abs, clientTag);
      return;
    }

    if (pathname === '/') pathname = '/room.html';
    const abs = resolveWithin(PUBLIC_DIR, pathname);
    if (!abs) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    sendFile(req, res, abs, clientTag);
  });

  // -------------------------------------------------------------------------
  // Websocket
  // -------------------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    /**
     * Per-connection state. Identity is server-assigned and lives only here,
     * which is what makes it unspoofable: there is no field on the wire in
     * which a client could claim to be someone else, because every routing
     * field is filled from this record.
     *
     * `superseded` marks a connection whose membership was reclaimed by a
     * later connection presenting that membership's reclaim secret. Its close
     * must NOT be announced as a departure — see handleJoin.
     */
    const conn = {
      clientId: /** @type {string|null} */ (null),
      roomName: /** @type {string|null} */ (null),
      tabId: /** @type {string|null} */ (null),
      role: /** @type {'host'|'viewer'|null} */ (null),
      superseded: false,
      missedPings: 0,
      awaitingPong: false,
    };
    // The liveness sweep iterates sockets, and a host reclaim reaches the
    // superseded connection through its member record. Both need this state
    // from the socket, so it is hung off it under a private name.
    ws._connState = conn;

    ws.on('pong', () => {
      conn.awaitingPong = false;
      conn.missedPings = 0;
    });

    ws.on('message', (data) => {
      // Receive time first, before parsing, for the same reason the client
      // stamps t4 before JSON.parse: anything between arrival and the stamp
      // is measured as network delay by whoever consumes the sample.
      const recv = serverNow();

      let env;
      try {
        env = JSON.parse(data.toString('utf8'));
      } catch (err) {
        refuse(ws, conn, recv, ERROR_CODES.BAD_ENVELOPE, `not valid JSON: ${err.message}`);
        return;
      }

      const shape = validateClientEnvelope(env);
      if (!shape.ok) {
        refuse(ws, conn, recv, ERROR_CODES.BAD_ENVELOPE, shape.reason);
        return;
      }

      if (env.type === TYPE_JOIN) {
        handleJoin(ws, conn, env, recv);
        return;
      }

      if (conn.clientId === null) {
        refuse(ws, conn, recv, ERROR_CODES.NOT_JOINED, `"${env.type}" arrived before join`);
        return;
      }

      const room = rooms.get(conn.roomName);
      if (!room) {
        // Only reachable if a room were reaped out from under a live member,
        // which the reap rule makes impossible. Refuse rather than throw.
        refuse(ws, conn, recv, ERROR_CODES.NOT_JOINED, 'room no longer exists');
        return;
      }

      if (env.type === TYPE_LEAVE) {
        departMember(room, conn, 'leave');
        ws.close(1000, 'left');
        return;
      }

      if (env.type === TYPE_ECHO) {
        emit(ws, makeEchoReply(directedRouting(conn, recv, { replyTo: env.id })));
        return;
      }

      route(ws, room, conn, env, recv);
    });

    ws.on('close', () => {
      if (conn.superseded) return; // already removed by the reclaim that replaced it
      if (conn.clientId === null || conn.roomName === null) return; // never joined
      const room = rooms.get(conn.roomName);
      if (room) departMember(room, conn, 'close');
    });

    ws.on('error', (err) => log(`socket error (${conn.clientId ?? 'unjoined'}): ${err.message}`));
  });

  /**
   * Route an envelope the server does not understand and must not try to.
   *
   * The relay copies the client's whole envelope and overwrites only the four
   * fields the server owns, which gives byte-identical delivery by
   * construction rather than by care — and replaces anything the client wrote
   * into `from`, `room`, `seq` or `ts` with the truth from `conn`.
   */
  function route(ws, room, conn, env, recv) {
    if (env.to === ADDR_ROOM) {
      room.seq += 1;
      const out = relayEnvelope(env, {
        room: room.name,
        from: conn.clientId,
        to: ADDR_ROOM,
        seq: room.seq,
        recv,
      });
      broadcast(room, out);
      return;
    }

    if (env.to === ADDR_SERVER) {
      // join, leave and echo are handled above; anything else addressed to the
      // server has no handler, and silently dropping it would leave a client
      // waiting on a reply that is never coming.
      refuse(ws, conn, recv, ERROR_CODES.BAD_ENVELOPE, `no server handler for type "${env.type}"`);
      return;
    }

    const target = room.members.get(env.to);
    if (!target) {
      refuse(ws, conn, recv, ERROR_CODES.UNKNOWN_RECIPIENT, `no member "${env.to}" in room "${room.name}"`);
      return;
    }

    // Directed envelopes carry seq: null and are outside the room's order. A
    // single counter across both would give each client an arbitrary
    // subsequence, and "gapless" would stop meaning anything (design.md D5).
    const out = relayEnvelope(env, {
      room: room.name,
      from: conn.clientId,
      to: target.clientId,
      seq: null,
      recv,
    });
    emit(target.ws, out);
  }

  // -------------------------------------------------------------------------
  // Join
  // -------------------------------------------------------------------------

  function handleJoin(ws, conn, env, recv) {
    if (conn.clientId !== null) {
      refuse(ws, conn, recv, ERROR_CODES.ALREADY_JOINED, 'this connection has already joined');
      return;
    }

    // Version is checked HERE and nowhere else (design.md D2). A per-message
    // check would cost every message for a condition that cannot change
    // mid-connection.
    if (env.v !== PROTOCOL_VERSION) {
      refuse(ws, conn, recv, ERROR_CODES.VERSION_MISMATCH, 'protocol version mismatch', {
        expected: PROTOCOL_VERSION,
        got: env.v ?? null,
      });
      return;
    }

    const request = readJoinRequest(env);
    if (!request.ok) {
      refuse(ws, conn, recv, ERROR_CODES.BAD_ENVELOPE, request.reason);
      return;
    }

    const room = getOrCreateRoom(request.room);

    // ---------------------------------------------------------------------
    // The whole join rule, in gate order: identity, then the name, then the
    // host role (1b design.md D10, which has the decision table). Every join
    // lands in exactly one branch.
    //
    // IDENTITY FIRST, and identity is the secret alone — never the `tabId`,
    // which the server broadcasts to the whole room in every roster.
    //
    // NOTHING HERE CONSULTS LIVENESS, and nothing may: a tab does not need
    // protection from itself, so the server never has to decide whether the
    // incumbent is dead. That is what removes change 1's D7 lockout.
    // ---------------------------------------------------------------------
    const reclaimed = findBySecret(room, request.secret);

    if (!reclaimed) {
      // A NEW membership, and only now is the message read. The label must be
      // free — `tabId` is unique per room for every role (1b design.md D3),
      // because change 6 attributes bytes per tab and two members sharing a
      // label merge into one bucket with no "unknown" bucket to reveal it.
      const holder = findByTabId(room, request.tabId);
      if (holder) {
        refuse(ws, conn, recv, ERROR_CODES.TAB_TAKEN, `tabId "${request.tabId}" is in use in room "${room.name}"`, {
          // Advice about retrying, never part of the decision (D13).
          releaseWithinMs: msUntilNameReleased(holder, livenessMs),
        });
        return;
      }

      // At most one host per room — deliberately a SEPARATE rule, and it runs
      // after the label gate, so a member rejoining as `host` off a roster it
      // was broadcast is refused by the label, exactly as a viewer would be.
      if (request.role === 'host' && findHost(room)) {
        refuse(ws, conn, recv, ERROR_CODES.HOST_TAKEN, `room "${room.name}" already has a host`);
        return;
      }
    }

    const clientId = newClientId();
    // Fresh on EVERY admitting join, a reclaim included (1b design.md D2).
    // The previous member is deleted below, so its secret dies with it — which
    // is also why no server-side guard against the reclaim loop exists: a
    // replaced connection that rejoins presents a secret for a member that no
    // longer exists and is refused.
    const secret = newReclaimSecret();
    const member = {
      clientId,
      // A reclaim restores the MEMBERSHIP's label, join time and role (1b
      // design.md D8). The role and label in a reclaiming join are not read at
      // all — not read is stronger than checked.
      tabId: reclaimed ? reclaimed.tabId : request.tabId,
      role: reclaimed ? reclaimed.role : request.role,
      joinedAt: reclaimed ? reclaimed.joinedAt : recv,
      secret,
      ws,
    };

    // A reclaim must never let another member observe a hostless roster. So
    // the old member is removed and the new one added BEFORE anything is
    // broadcast, and the old connection's close is suppressed — one presence
    // message goes out, and every roster in it holds exactly one host.
    if (reclaimed) {
      // Logged, never refused: only a hand-written client can produce a
      // disagreement, so what is wanted is a line a human can find, not a
      // protocol state a program branches on. Change 6 writes its own clients,
      // which is why the line is worth having. The secret is never printed.
      if (request.role !== reclaimed.role) {
        log(
          `reclaim in ${room.name} claimed role=${request.role} but the membership holds role=${reclaimed.role}; keeping the held role`
        );
      }
      if (request.tabId !== reclaimed.tabId) {
        log(
          `reclaim in ${room.name} named tabId=${request.tabId} but the membership holds tabId=${reclaimed.tabId}; keeping the held tabId`
        );
      }
      room.members.delete(reclaimed.clientId);
      reclaimed.ws._connState.superseded = true;
      log(`membership reclaimed in ${room.name} tabId=${member.tabId} (${reclaimed.clientId} -> ${clientId})`);
    }

    room.members.set(clientId, member);
    conn.clientId = clientId;
    conn.roomName = room.name;
    conn.tabId = member.tabId;
    conn.role = member.role;

    // `joined` is directed and outside the room order (seq: null). The room
    // counter it reports is the value at this instant, so the first
    // room-scoped envelope this client sees carries the next one. It is also
    // the only envelope the secret is ever written into (1b design.md D12).
    emit(
      ws,
      makeJoined(directedRouting(conn, recv), {
        clientId,
        roster: rosterOf(room),
        roomSeq: room.seq,
        serverTime: serverNow(),
        secret,
      })
    );

    // Tells the superseded client it was replaced rather than disconnected, so
    // it stops cleanly. Rotation, not this code, is what makes taking the role
    // back impossible (1b design.md D5).
    if (reclaimed) reclaimed.ws.close(CLOSE_SUPERSEDED, 'membership reclaimed by the same tab');

    announce(room, 'join', member, recv);
    log(`join ${room.name} ${clientId} tabId=${member.tabId} role=${member.role} (${room.members.size} member(s))`);
  }

  /**
   * Broadcast the FULL roster on every membership change, never a delta
   * (design.md D7): a client that maintains no incremental presence state
   * cannot drift out of agreement with the server about who is present, and
   * change 10 measures churn against this roster.
   */
  function announce(room, event, member, recv) {
    room.seq += 1;
    broadcast(
      room,
      makePresence(
        { room: room.name, to: ADDR_ROOM, seq: room.seq, recv },
        { event, member: rosterEntry(member), roster: rosterOf(room) }
      )
    );
  }

  /** Remove a member, announce it, and reap the room if it was the last one. */
  function departMember(room, conn, reason) {
    const member = room.members.get(conn.clientId);
    if (!member) return;
    room.members.delete(conn.clientId);
    log(`depart ${room.name} ${conn.clientId} (${reason}), ${room.members.size} left`);
    if (room.members.size > 0) announce(room, 'leave', member, serverNow());
    reapIfEmpty(room);
    conn.clientId = null;
  }

  // -------------------------------------------------------------------------
  // Liveness
  //
  // ws PING FRAMES, not application messages, so a half-open TCP connection
  // cannot leave a ghost in the roster indefinitely.
  //
  // Three ticks from a healthy connection, not two: ping, count one missed
  // pong, terminate on the tick after. `msUntilNameReleased` above reports the
  // same three. The sweep is deliberately PATIENT — change 7a's host saturates
  // its uplink and is routinely slow to pong, and dropping it takes every
  // peer's media source with it.
  // -------------------------------------------------------------------------
  const livenessTimer = setInterval(() => {
    for (const ws of wss.clients) {
      const conn = ws._connState;
      if (!conn) continue;
      if (conn.awaitingPong) {
        conn.missedPings += 1;
        if (conn.missedPings >= 2) {
          log(`terminating unresponsive connection ${conn.clientId ?? 'unjoined'}`);
          ws.terminate(); // fires 'close', which departs the member
          continue;
        }
      }
      conn.awaitingPong = true;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, livenessMs);
  livenessTimer.unref?.();

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[room] ERROR: port ${port} is already in use.\n` +
          `[room] Another copy of this server is the likely culprit. Note that step0 uses 8080 and 8000,\n` +
          `[room] and spike-host-origin uses 8080, 8001 and 8000 — none of which should collide with ${port}.\n` +
          `[room] On Windows: Get-NetTCPConnection -LocalPort ${port} -State Listen | Stop-Process`
      );
      process.exit(1);
    }
    console.error('[room] server error:', err);
    process.exit(1);
  });

  let closed = false;
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    clearInterval(livenessTimer);
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => {
      wss.close(() => httpServer.close(() => resolve()));
    });
  }

  const ready = new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      const actual = httpServer.address().port;
      log(`listening on http://${host}:${actual} (ws at /ws)`);
      log(`media root: ${mediaDir}`);
      log(`liveness: ping every ${livenessMs}ms, terminate after 2 unanswered`);
      resolve(actual);
    });
  });

  return { httpServer, wss, rooms, close, ready, mediaDir, livenessMs, serverNow, counters };
}

/** The server's options as `npm start` and the origin container read them from the environment. */
export function optionsFromEnv(env = process.env) {
  let iceServers = [];
  if (env.APP_ICE_SERVERS !== undefined) {
    iceServers = JSON.parse(env.APP_ICE_SERVERS);
    if (!Array.isArray(iceServers)) throw new TypeError('APP_ICE_SERVERS must be a JSON array');
  }
  return {
    port: env.APP_PORT ? Number(env.APP_PORT) : undefined,
    mediaDir: env.APP_MEDIA_DIR,
    livenessMs: env.APP_LIVENESS_INTERVAL_MS ? Number(env.APP_LIVENESS_INTERVAL_MS) : undefined,
    delivery: env.APP_DELIVERY,
    iceServers,
    trackerUrl: normalizeTrackerUrl(env.APP_TRACKER_URL),
  };
}

// Run directly: `npm start`.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const server = startRoomServer(optionsFromEnv());
  process.on('SIGINT', () => {
    console.log('[room] SIGINT received, closing');
    server.close().then(() => process.exit(0));
  });
}
