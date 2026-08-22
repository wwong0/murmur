// public/lib/clock-sync.mjs
//
// The driver: it schedules probes, feeds the filter, and exposes the estimate.
// Everything with a timer, a retry or a lifecycle lives here, so the filter next
// door can stay a pure function of its inputs. The reasoning behind each rule
// below is change 2 design.md D5, D8 and D9.
//
// It also holds `websocketProbe`. THAT IS THE SEAM CHANGE 6 NEEDS: settling
// whether the clock stays on the websocket or moves to a WebRTC data channel
// must be a substitution here, not a rewrite of the filter (D2).
//
// Under public/lib/: no DOM, no page access.

import { createClockFilter } from './clock-filter.mjs';

/**
 * The client's timebase. Same construction as room-client's `clientNow`, and
 * THEY MUST STAY THE SAME: `t1`/`t4` come from that one and `sharedNow()` from
 * this one, so if they diverge the offset is measured against one clock and
 * applied to another.
 */
function defaultNow() {
  return performance.timeOrigin + performance.now();
}

/** Resolved in place of a probe that did not settle in time. */
const TIMED_OUT = Symbol('probe-timed-out');

/**
 * Whatever a timed-out probe eventually says is discarded: nothing is listening
 * to it any more, so a late reply cannot land as a sample attributed to the
 * probe that replaced it.
 */
function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(TIMED_OUT), ms);
    if (t && typeof t === 'object' && t.unref) t.unref();
    promise.then(
      (value) => {
        clearTimeout(t);
        resolve(value);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      }
    );
  });
}

/**
 * Burst on join, then a steady cadence. `burstCount` NARROWS the clock, it does
 * not enable it — one accepted sample is already a complete estimate with an
 * honest bound. `steadyIntervalMs` AND THE FILTER'S WINDOW LENGTH ARE ONE
 * SETTING IN TWO PLACES; see DEFAULT_WINDOW in clock-filter.mjs.
 */
export const DEFAULT_SCHEDULE = Object.freeze({
  burstCount: 8,
  burstIntervalMs: 250,
  steadyIntervalMs: 2000,
});

/**
 * @param {object} config
 * @param {(timeoutMs: number) => Promise<object|null>} config.probe
 * @param {object} [config.filter]   defaults to a filter with shipped settings
 * @param {object} [config.schedule] see DEFAULT_SCHEDULE
 * @param {() => number} [config.now] injected by the checks so an estimate can be
 *   read at an exact instant; the page uses the default
 * @param {(subscriber: Function) => Function} [config.onJoined]
 *   room-client's `joined` event, which fires again on every rejoin — so the
 *   burst needs no new lifecycle event and no knowledge of reconnection
 */
export function createClockSync(config) {
  const {
    probe,
    filter = createClockFilter(),
    schedule: scheduleConfig = {},
    now = defaultNow,
    onJoined,
  } = config;

  const schedule = { ...DEFAULT_SCHEDULE, ...scheduleConfig };

  const probes = { issued: 0, abandoned: 0, errors: 0 };

  let running = false;
  let timer = null;
  let burstLeft = 0;
  let inFlight = false;
  let lastError = null;
  // Bumped on stop, so a probe in flight at that moment cannot feed the filter
  // or arm another timer after the caller has said stop.
  let generation = 0;

  function armTimer(delayMs) {
    timer = setTimeout(tick, delayMs);
    // The protocol check imports this module. A driver that can hold a Node
    // process open turns a check people run constantly into one that hangs.
    if (timer && typeof timer === 'object' && timer.unref) timer.unref();
  }

  /**
   * ONE PROBE IN FLIGHT, EVER, and the next is scheduled only once this one has
   * resolved or been given up on. Two concurrent probes share a queue — and over
   * a websocket a TCP connection as well — so the second one's `t4` carries
   * head-of-line blocking behind the first, which is exactly the one-directional
   * delay the filter exists to reject.
   */
  async function tick() {
    if (!running) return;
    const mine = generation;
    inFlight = true;
    if (burstLeft > 0) burstLeft -= 1;

    // A PROBE MAY NOT OUTLIVE THE MOMENT ITS REPLACEMENT IS DUE, so the timeout
    // is the cadence and no new number is introduced. room-client's 5000ms
    // request default would turn a two-second burst into a seven-second one at
    // the loss rate criterion 1 names.
    const timeoutMs = schedule.steadyIntervalMs;
    probes.issued += 1;
    // Real elapsed time, not the injected `now`: that one is the estimate's
    // timebase and a check is free to move it arbitrarily.
    const issuedAt = Date.now();

    let outcome = null;
    try {
      outcome = await withDeadline(probe(timeoutMs), timeoutMs);
    } catch (err) {
      // A probe is required to report a lost exchange rather than throw, so this
      // is a defect in the probe — counted and carried on with, because an
      // exception escaping a timer chain stops the clock for the life of the
      // page and says nothing about why. It still reaches the filter below as
      // the lost exchange it is.
      probes.errors += 1;
      lastError = err;
    }
    inFlight = false;

    if (mine !== generation || !running) return; // stopped while in flight
    if (outcome === TIMED_OUT) {
      probes.abandoned += 1;
      outcome = null;
    }
    filter.add(outcome ?? null);

    // THE INTERVAL RUNS FROM ISSUE, NOT FROM COMPLETION. An abandoned probe has
    // already consumed a whole interval, so waiting another one after it halves
    // the probe rate in the one condition where samples matter most.
    const interval = burstLeft > 0 ? schedule.burstIntervalMs : schedule.steadyIntervalMs;
    armTimer(Math.max(0, interval - (Date.now() - issuedAt)));
  }

  /**
   * A burst, now. Fired on every successful join, a rejoin included.
   *
   * A probe already in flight is left alone rather than cancelled: it is a
   * legitimate exchange, and the tick running it re-arms from `burstLeft` when
   * it lands. That is what keeps "one probe in flight" true across a rejoin
   * arriving mid-exchange.
   */
  function burst() {
    if (!running) return;
    burstLeft = schedule.burstCount;
    if (inFlight) return;
    if (timer) clearTimeout(timer);
    armTimer(0);
  }

  let offJoined = null;

  function start() {
    if (running) return;
    running = true;
    // A DISCONNECT DOES NOT RESET ANYTHING (D8) — the offset is a property of
    // two timebases, not of a connection. Safe only because the age term keeps
    // widening the reported uncertainty while nothing new arrives.
    if (onJoined && !offJoined) offJoined = onJoined(() => burst());
    // STARTING IS ITSELF A REASON TO BURST, not only joining: a driver started
    // after its client has already joined never sees a `joined` event, and
    // starting it from the page's own `joined` handler is precisely that case.
    burst();
  }

  /**
   * STOP CLEARS THE SCHEDULING STATE, ALL OF IT. Leave `inFlight` set and the
   * next `start()` sees a probe that only a superseded generation will ever
   * resolve, so `burst()` declines to arm a timer and nothing ever arms one
   * again — a driver reporting itself running while its clock silently stops.
   * The window and the estimate are NOT cleared; they survive by design (D8).
   */
  function stop() {
    running = false;
    generation += 1;
    inFlight = false;
    burstLeft = 0;
    if (timer) clearTimeout(timer);
    timer = null;
    if (offJoined) {
      offJoined();
      offJoined = null;
    }
  }

  /**
   * The estimate AS DATA, not as text for a page (D5). Change 6 runs headless
   * clients and must log the uncertainty alongside every drift figure; a number
   * rendered into a string on a page nothing opens is unreachable.
   */
  function read(atMs = now()) {
    const record = filter.read(atMs);
    return {
      ...record,
      atMs,
      probes: { ...probes },
      lastProbeError: lastError ? String(lastError.message ?? lastError) : null,
    };
  }

  /**
   * The room's time, or `null` while there is no estimate — never this client's
   * own clock as a stand-in (D9).
   *
   * NOT MONOTONIC ACROSS AN ESTIMATE UPDATE: when the estimate moves this moves
   * with it, backwards included. Clamping would trade a visible discontinuity
   * for an invisible accumulating lie. Change 4 owns what to do about a step,
   * and has `reanchors` and the half-width to tell a step from drift.
   */
  function sharedNow(atMs = now()) {
    const record = filter.read(atMs);
    return record.offsetMs === null ? null : atMs + record.offsetMs;
  }

  return { start, stop, burst, read, sharedNow, schedule, filter };
}

/**
 * The websocket probe: `echo()` in, a sample out (D10).
 *
 * `t1` and `t4` come from the stamps room-client takes AT THE WIRE. NOTHING HERE
 * MAY RECOMPUTE OR ADJUST ANY OF THEM: every millisecond between the true event
 * and the stamp is measured as network delay by whoever consumes the sample.
 * A LOST EXCHANGE IS `null`, NEVER A THROW.
 */
export function websocketProbe(roomClient) {
  return async (timeoutMs) => {
    let reply;
    try {
      reply = await roomClient.echo(timeoutMs);
    } catch {
      return null;
    }
    const local = reply && reply.local;
    const ts = reply && reply.ts;
    if (!local || !ts || typeof local.t1 !== 'number' || typeof local.t4 !== 'number') return null;
    return { t1: local.t1, t2: ts.recv, t3: ts.send, t4: local.t4 };
  };
}
