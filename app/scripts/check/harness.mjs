// scripts/check/harness.mjs
//
// Assertions, the check runner, and the two client shapes the suites drive the
// server with: a raw websocket `Peer`, and room-client behind a recording
// socket.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a check owns a room and everything it
// opens in that room, and all of it is closed when the check ends — whether it
// passed or threw. Teardown written at the end of a check body only runs on the
// happy path, so a failing check used to leak its sockets into the rest of the
// run. That matters most for room-client, which reconnects by default: a leaked
// client keeps rejoining underneath every later timing assertion, and one
// failure manufactures the next.
//
// No test framework — step0/ establishes invariant checks in plain scripts as
// this project's convention (see step0/scripts/aggregate.mjs). `newScope` is
// about forty lines of bookkeeping inside that convention, not a framework.
//
// Node 24, ESM, ws + node:net.

import net from 'node:net';
import { WebSocket } from 'ws';

import { createRoomClient } from '../../public/lib/room-client.mjs';
import {
  PROTOCOL_VERSION,
  ADDR_SERVER,
  TYPE_JOIN,
  TYPE_JOINED,
  TYPE_ERROR,
} from '../../public/lib/envelope.mjs';

import { server, port, WS } from './fixtures.mjs';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export function assert(cond, message) {
  if (!cond) throw new Error(message);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Raw HTTP
// ---------------------------------------------------------------------------

/**
 * GET a request target VERBATIM, over a raw socket. Every HTTP client in reach
 * — fetch, undici, node:http's own client — resolves dot segments before the
 * bytes go out, so none of them can express the request a traversal actually
 * looks like. This can.
 */
const CRLF = '\r\n';

export function rawGet(target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1${CRLF}Host: 127.0.0.1:${port}${CRLF}Connection: close${CRLF}${CRLF}`);
    });
    let raw = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => (raw += chunk));
    socket.on('end', () => {
      const status = Number(raw.slice(9, 12));
      const split = raw.indexOf(CRLF + CRLF);
      resolve({ status, body: split === -1 ? '' : raw.slice(split + 4) });
    });
    socket.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// A raw websocket peer
//
// Deliberately raw — it builds envelopes by hand rather than through
// room-client, so the wire format is asserted against the spec instead of
// against whatever the client module happens to do. room-client gets its own
// suite.
// ---------------------------------------------------------------------------

export class Peer {
  constructor(url, label) {
    this.label = label;
    this.url = url;
    this.received = [];
    this.cursor = 0;
    this.closed = false;
    this.closeCode = null;
    // Liveness pings this socket has been sent. The D13 no-probe assertion runs
    // against a server whose sweep cannot fire during it, so any ping counted
    // there was sent for the refusal.
    this.pings = 0;
    this.ws = new WebSocket(url);
    this.ws.on('ping', () => this.pings++);
    this.ws.on('message', (data) => this.received.push(JSON.parse(data.toString('utf8'))));
    this.ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
    });
    this.ws.on('error', () => {});
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  static async open(url, label) {
    const peer = new Peer(url, label);
    await peer.opened;
    return peer;
  }

  /** Send an envelope as-is. Nothing is filled in for the caller — that is the point. */
  send(env) {
    this.ws.send(JSON.stringify(env));
  }

  sendRaw(text) {
    this.ws.send(text);
  }

  /**
   * Join, and return whichever of `joined` / `error` comes back.
   *
   * `secret` is omitted unless the caller passes one, so a peer that means to
   * be a stranger looks like one on the wire.
   */
  async join({ room, tabId, role, secret, v = PROTOCOL_VERSION }) {
    const body = { room, tabId, role };
    if (secret !== undefined) body.secret = secret;
    this.send({ v, type: TYPE_JOIN, to: ADDR_SERVER, payload: body });
    const reply = await this.next((e) => e.type === TYPE_JOINED || e.type === TYPE_ERROR);
    if (reply.type === TYPE_JOINED) {
      this.clientId = reply.payload.clientId;
      this.secret = reply.payload.secret;
    }
    return reply;
  }

  /**
   * The next envelope, from the read cursor forward, matching `pred`.
   * Consuming semantics: a matched envelope advances the cursor past it, so
   * two successive waits for the same predicate see two different messages.
   */
  async next(pred, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = this.cursor; i < this.received.length; i++) {
        if (pred(this.received[i])) {
          this.cursor = i + 1;
          return this.received[i];
        }
      }
      if (Date.now() > deadline) {
        throw new Error(
          `${this.label}: timed out waiting for a matching envelope; saw [${this.received.map((e) => `${e.type}#${e.seq}`).join(', ')}]`
        );
      }
      await sleep(5);
    }
  }

  /** Assert nothing matching arrives within `ms`. */
  async none(pred, ms = 250) {
    await sleep(ms);
    const hit = this.received.slice(this.cursor).find(pred);
    if (hit) throw new Error(`${this.label}: expected no matching envelope, got ${JSON.stringify(hit)}`);
  }

  /** Every room-scoped envelope this connection has seen, in arrival order. */
  roomScoped() {
    return this.received.filter((e) => e.seq !== null && e.seq !== undefined);
  }

  /** Stop reading from the socket without closing it — a half-open connection. */
  goSilent() {
    this.ws._socket.pause();
  }

  waitClosed(timeoutMs = 2000) {
    if (this.closed) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: socket did not close in ${timeoutMs}ms`)), timeoutMs);
      this.ws.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Server introspection
//
// Both of these reach into the live server rather than inferring state from the
// wire, which is the point: several assertions are about what the server is
// holding, not about what it said.
// ---------------------------------------------------------------------------

/** The live member record, straight out of the server. */
export function memberOf(roomName, clientId) {
  const room = server.rooms.get(roomName);
  return room ? room.members.get(clientId) : undefined;
}

export function rosterOfRoom(roomName) {
  const room = server.rooms.get(roomName);
  return room ? [...room.members.values()] : [];
}

// ---------------------------------------------------------------------------
// room-client machinery
// ---------------------------------------------------------------------------

/**
 * A websocket that also records what room-client sends and receives, keeps a
 * handle on the live socket, and can rewrite an outgoing envelope on the way
 * past.
 *
 * room-client deliberately exposes no getter for its reclaim secret — putting
 * one there is how a secret ends up in somebody's log line — so the only honest
 * way to assert what it holds and what it presents is to read the wire
 * underneath it. This is test-only machinery injected through the existing
 * `WebSocketImpl` seam; the module gains no surface for it.
 *
 * `rewrite` is how a check provokes a server-side refusal that room-client's own
 * envelope builders will never produce — a stale protocol version, say. It maps
 * one parsed envelope to the envelope actually sent, and `wire.sent` records
 * what went out rather than what was asked for. THE SEAM BELONGS HERE, NOT IN A
 * SUITE: a second near-identical WebSocket subclass is how two of them drift.
 *
 * @param {{rewrite?: (env: object) => object}} [options]
 */
export function recordingSocket({ rewrite } = {}) {
  const wire = { sent: [], received: [], socket: /** @type {any} */ (null) };
  const Impl = class RecordingWebSocket extends WebSocket {
    constructor(url) {
      super(url);
      wire.socket = this;
      this.addEventListener('message', (ev) => {
        const raw = ev && ev.data !== undefined ? ev.data : ev;
        try {
          wire.received.push(JSON.parse(typeof raw === 'string' ? raw : String(raw)));
        } catch {
          /* room-client's own parse failure path covers this */
        }
      });
    }

    send(data) {
      let env;
      try {
        env = JSON.parse(data);
      } catch {
        return super.send(data); // not JSON: nothing this check asserts on
      }
      if (!rewrite) {
        // Forward the original bytes, so a check without a rewrite cannot be
        // affected by this file's serialisation.
        wire.sent.push(env);
        return super.send(data);
      }
      const rewritten = rewrite(env);
      wire.sent.push(rewritten);
      return super.send(JSON.stringify(rewritten));
    }
  };
  return { Impl, wire };
}

export const joinsIn = (wire) => wire.sent.filter((e) => e.type === TYPE_JOIN);
export const joinedIn = (wire) => wire.received.filter((e) => e.type === TYPE_JOINED);

export function waitEvent(client, name, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`room-client: no "${name}" event within ${timeoutMs}ms`)), timeoutMs);
    const off = client.onEvent(name, (data) => {
      clearTimeout(timer);
      off();
      resolve(data);
    });
  });
}

// ---------------------------------------------------------------------------
// Rooms and the per-check scope
// ---------------------------------------------------------------------------

let roomCounter = 0;

/** A room name no other check has used. Suites needing a second room call it directly. */
export const nextRoom = () => `r${roomCounter++}`;

/**
 * Everything one check is allowed to own: a fresh room, and a registry of the
 * peers and clients opened in it so `check` can close them unconditionally.
 *
 * `peer` opens without joining, for the checks whose SUBJECT is the join reply.
 * `member` opens, joins and asserts admission, for the ones that just need a
 * cast to be present. Both take an explicit `room` for the handful of checks
 * that run the same scenario against more than one server.
 */
function newScope() {
  const room = nextRoom();
  const owned = [];

  async function peer(label, url = WS) {
    const p = await Peer.open(url, label);
    owned.push(p);
    return p;
  }

  async function member(label, role = 'viewer', opts = {}) {
    const { url = WS, tabId = label, room: inRoom = room, ...rest } = opts;
    const p = await peer(label, url);
    const reply = await p.join({ room: inRoom, tabId, role, ...rest });
    assertEqual(reply.type, TYPE_JOINED, `${label} should have been admitted (${JSON.stringify(reply.payload)})`);
    return p;
  }

  function client(tabId, role = 'viewer', extra = {}) {
    // `extra` spreads last so a check can override the url or the room.
    const c = createRoomClient({ url: WS, room, tabId, role, WebSocketImpl: WebSocket, ...extra });
    owned.push(c);
    return c;
  }

  function dispose() {
    for (const item of owned) {
      try {
        item.close();
      } catch {
        /* already gone; teardown must never be the thing that fails a run */
      }
    }
  }

  return { room, peer, member, client, dispose };
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export const results = [];

/**
 * The stack, not just the message. There are around four hundred assertions
 * across the suites and messages like 'error code' repeat across them, so a
 * bare message names the symptom without naming the line.
 */
function formatError(err) {
  const text = err && err.stack ? err.stack : String(err);
  return text
    .split('\n')
    .map((line) => `        ${line}`)
    .join('\n');
}

function record(result) {
  results.push(result);
  console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
  if (!result.ok) console.log(formatError(result.error));
}

async function runScoped(name, fn) {
  const scope = newScope();
  try {
    await fn(scope);
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, error: err };
  } finally {
    scope.dispose();
  }
}

export async function check(name, fn) {
  record(await runScoped(name, fn));
}

/**
 * Run several checks CONCURRENTLY, then report them in declaration order.
 *
 * For checks whose cost is wall-clock rather than work — the ones that sleep to
 * prove a negative, or wait out a liveness sweep or a reconnect backoff.
 * Serialising those buys nothing: each `check` already takes a room of its own,
 * so their assertions are room-scoped and cannot observe each other.
 *
 * NOT FOR CHECKS THAT MEASURE ELAPSED TIME AS AN UPPER BOUND against a small
 * constant. Concurrency cannot move a lower bound or a "nothing happened", but
 * it can absolutely inflate a tight `elapsed < 100`. Those stay serial, and
 * the ones that do belong here say so at their call site.
 *
 * @param {[string, Function][]} entries
 */
export async function checkGroup(entries) {
  const settled = await Promise.all(entries.map(([name, fn]) => runScoped(name, fn)));
  for (const result of settled) record(result);
}

export function report() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\nprotocol-check: ${results.length - failed.length}/${results.length} assertions passed`);
  if (failed.length > 0) {
    console.log('\nfailed:');
    for (const f of failed) console.log(`  - ${f.name}`);
    return 1;
  }
  return 0;
}
