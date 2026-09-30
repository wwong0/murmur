// scripts/check/suites/drift-readout.mjs
//
// The one line of text the page shows about drift, and — the part that matters
// — what it says when there is nothing to show. A healthy page never reaches
// those branches, so the browser pass cannot exercise them: it would have to
// break a real client's clock to see one. Here they are three lines of setup.
//
// NO SERVER, NO BROWSER, NO ELAPSED TIME. The read-out reads a log and a status
// and returns a string; both are supplied by the caller.

import { check, assert, assertEqual } from '../harness.mjs';
import { createDriftLog } from '../../../public/lib/frame-drift.mjs';
import {
  createDriftReadout,
  DRIFT_LINE_NO_RECORDS_RE,
  DRIFT_LINE_NOT_PLAYING_RE,
  DRIFT_LINE_RE,
  driftLineForm,
} from '../../../public/lib/drift-readout.mjs';
import { REFUSAL_REASONS } from '../../../public/lib/frame-drift.mjs';
import {
  MISSING_CLOCK,
  MISSING_HOST_LINK,
  MISSING_STATE,
  WAITING_HELD,
  WAITING_PAUSED,
  WAITING_PREPARING,
  WAITING_REFUSED,
} from '../../../public/lib/playback-start.mjs';

/** The load rule's status, as the read-out consumes it — set directly by each check. */
function fakePlayback(state = { playing: false, missing: MISSING_CLOCK }) {
  const held = { state };
  return { held, state: () => held.state };
}

/** A record carrying one drift figure. Only `driftMs` reaches the line. */
const drifted = (driftMs) => ({ ok: true, record: { driftMs, clock: {} } });

function rig({ heldAhead = () => null } = {}) {
  const log = createDriftLog();
  const playback = fakePlayback();
  return { log, playback, readout: createDriftReadout({ log, playback, heldAhead }) };
}

export default async function driftReadoutSuite() {
  await check('drift read-out: a page that is not playing names the input it is waiting for', async () => {
    const { playback, readout } = rig();
    assertEqual(readout.text(), `drift: not playing — waiting for ${MISSING_CLOCK}`, 'the missing input is named, not summarised');

    playback.held.state = { playing: false, missing: MISSING_STATE, waiting: null, retargets: 0 };
    assertEqual(readout.text(), `drift: not playing — waiting for ${MISSING_STATE}`, 'a missing state is named');

    // Every input present: the waiting reason is named instead, and the pair
    // differs only in `waiting` (retargets equal, missing null in both).
    const base = { playing: false, missing: null, retargets: 3 };
    const lines = [WAITING_PAUSED, WAITING_PREPARING, WAITING_REFUSED].map((waiting) => {
      playback.held.state = { ...base, waiting };
      return readout.text();
    });
    assertEqual(lines[0], 'drift: not playing — room paused', 'a paused room says so');
    assertEqual(lines[1], 'drift: not playing — preparing start (retargets 3)', 'preparing names its retargets');
    assertEqual(lines[2], 'drift: not playing — start refused, click the page to start', 'a refused start names the remedy');
    assertEqual(new Set(lines).size, 3, 'the three reasons render distinctly');

    playback.held.state = { ...base, waiting: WAITING_HELD };
    assertEqual(readout.text(), 'drift: not playing — room held for the room · held-ahead not reported', 'a held host or not-yet-reporting viewer names the held room');
  });

  await check('drift read-out: a held viewer renders its held-ahead figure, and the figure is required by the shape', async () => {
    const { playback, readout } = rig({ heldAhead: () => ({ heldAheadMs: 4_250 }) });
    playback.held.state = { playing: false, missing: null, waiting: WAITING_HELD, retargets: 3 };
    const line = readout.text();
    assertEqual(line, 'drift: not playing — room held for the room · held-ahead 4.3 s', 'held-ahead is formatted to one decimal second');
    assert(DRIFT_LINE_NOT_PLAYING_RE.test(line), 'the figure-bearing held line matches the published not-playing shape');
    assert(!DRIFT_LINE_NOT_PLAYING_RE.test('drift: not playing — room held for the room'), 'a held line without its figure is not accepted');
  });

  await check('drift read-out: playing and recording nothing says WHICH counter is rising, fastest first', async () => {
    const { log, playback, readout } = rig();
    playback.held.state = { playing: true, missing: null };
    assertEqual(readout.text(), 'drift: no new records — nothing recorded yet', 'the first line has no previous counters to compare against');

    // rVFC silent: no frame was offered at all, which is a different fault from
    // frames arriving and being refused.
    assertEqual(readout.text(), 'drift: no new records — no frames offered — rVFC is silent', 'no frames offered is reported as no frames offered');

    for (let i = 0; i < 3; i++) log.add({ ok: false, reason: 'noEpoch' });
    for (let i = 0; i < 5; i++) log.add({ ok: false, reason: 'noClock' });
    assertEqual(readout.text(), 'drift: no new records — noClock rising (5 total)', 'the fastest riser is the one named, and it reports its running total');

    // The order is by RATE, not by total, AND THE FIXTURE SEPARATES THE TWO:
    // over this interval noEpoch rises twice as fast as noClock while ending
    // with a lower total, so an ordering by total would name the other one.
    for (let i = 0; i < 2; i++) log.add({ ok: false, reason: 'noEpoch' });
    log.add({ ok: false, reason: 'noClock' });
    assertEqual(readout.text(), 'drift: no new records — noEpoch rising (5 total)', 'the reason rising fastest since the last line wins, whatever the totals are');
  });

  await check('drift read-out: with records it reports the latest drift and the rolling window, in the shape the browser pass asserts', async () => {
    const { log, playback, readout } = rig();
    playback.held.state = { playing: true, missing: null };
    for (const ms of [-12.34, 4, 8, 100]) log.add(drifted(ms));

    const line = readout.text();
    const matched = DRIFT_LINE_RE.exec(line);
    assert(matched !== null, `the line matches the published contract — got ${JSON.stringify(line)}`);
    assertEqual(Number(matched[1]), 4, 'over the four records the ring holds');
    // Median of an even set is the mean of the middle two — 4 and 8 — which is
    // the drift log's definition and must not become a second one here.
    assertEqual(line, 'drift: +100.0ms · rolling window over the last 4 frames: median +6.0ms, p99 +100.0ms', 'the newest record leads, the window follows');

    // A second call with nothing new falls to the no-records branch rather than
    // repeating the last figure, which would read as a live measurement.
    assertEqual(readout.text(), 'drift: no new records — no frames offered — rVFC is silent', 'a stale figure is not reprinted as a fresh one');

    // And the window is the RING, not the unread tail: one new record reports a
    // median over all five, not over the one.
    log.add(drifted(8));
    assertEqual(readout.text(), 'drift: +8.0ms · rolling window over the last 5 frames: median +8.0ms, p99 +100.0ms', 'the window covers every record held, not only the new ones');
  });

  await check('drift read-out: every silent form has only its own published shape', async () => {
    const missing = [MISSING_CLOCK, MISSING_STATE, MISSING_HOST_LINK];
    const waiting = [WAITING_PAUSED, WAITING_PREPARING, WAITING_REFUSED, WAITING_HELD];
    const notPlaying = [
      ...missing.map((reason) => {
        const { playback, readout } = rig();
        playback.held.state = { playing: false, missing: reason, waiting: null, retargets: 3 };
        return readout.text();
      }),
      ...waiting.map((reason) => {
        const { playback, readout } = rig();
        playback.held.state = { playing: false, missing: null, waiting: reason, retargets: 3 };
        return readout.text();
      }),
      (() => {
        const { playback, readout } = rig();
        playback.held.state = { playing: false, missing: null, waiting: null, retargets: 3 };
        return readout.text();
      })(),
    ];
    const noRecords = [
      (() => {
        const { log, playback, readout } = rig();
        playback.held.state = { playing: true, missing: null };
        const line = readout.text();
        return { log, playback, readout, line };
      })(),
      ...REFUSAL_REASONS.map((reason) => {
        const { log, playback, readout } = rig();
        playback.held.state = { playing: true, missing: null };
        readout.text();
        log.add({ ok: false, reason });
        return { log, playback, readout, line: readout.text() };
      }),
    ];
    noRecords.push((() => {
      const { playback, readout } = rig();
      playback.held.state = { playing: true, missing: null };
      readout.text();
      return { line: readout.text() };
    })());
    const recording = (() => {
      const { log, playback, readout } = rig();
      playback.held.state = { playing: true, missing: null };
      log.add(drifted(4));
      return readout.text();
    })();

    for (const line of notPlaying) {
      assert(DRIFT_LINE_NOT_PLAYING_RE.test(line), `not-playing shape accepts ${line}`);
      assert(!DRIFT_LINE_NO_RECORDS_RE.test(line), `not-playing shape refuses no-records form ${line}`);
      assert(!DRIFT_LINE_RE.test(line), `silent line is not recording: ${line}`);
      assertEqual(driftLineForm(line), 'not-playing', 'form classifier names not-playing');
    }
    for (const { line } of noRecords) {
      assert(DRIFT_LINE_NO_RECORDS_RE.test(line), `no-records shape accepts ${line}`);
      assert(!DRIFT_LINE_NOT_PLAYING_RE.test(line), `no-records shape refuses not-playing form ${line}`);
      assert(!DRIFT_LINE_RE.test(line), `silent line is not recording: ${line}`);
      assertEqual(driftLineForm(line), 'no-new-records', 'form classifier names no-new-records');
    }
    assertEqual(recording, 'drift: +4.0ms · rolling window over the last 1 frames: median +4.0ms, p99 +4.0ms', 'recording fixture is a real record');
    assert(DRIFT_LINE_RE.test(recording), 'recording fixture matches the recording shape');
    assert(!DRIFT_LINE_NOT_PLAYING_RE.test(recording), 'recording fixture refuses not-playing shape');
    assert(!DRIFT_LINE_NO_RECORDS_RE.test(recording), 'recording fixture refuses no-records shape');
    assertEqual(driftLineForm(recording), 'recording', 'form classifier names recording');
  });
}
