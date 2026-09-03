// scripts/check/suites/diagnostics-overlay.mjs
//
// The pure suite for the overlay's clock, drift and controller lines. It builds
// the same text the browser paints and checks every reachable controller mode.
//
// TRAP: build every controller line before its assertions; otherwise a failed
// case can hide the collision that the uniqueness check is meant to catch.
//
// TRAP: every controller state below is one `drift-controller.mjs` can really
// reach, and the figures inside one are the ones ITS arithmetic would produce
// together — `fastestCloseMs` is `(|estimate| - deadband) / MAX_RATE_DEVIATION`
// and the rate follows from the same excess. A fixture free to combine figures
// the controller never combines can assert a line the page can never paint
// (CONSTRAINTS.md → *Verification*).

import { assert, assertEqual, check } from '../harness.mjs';
import { createDriftLog } from '../../../public/lib/frame-drift.mjs';
import { DRIFT_LINE_RE } from '../../../public/lib/drift-readout.mjs';
import {
  CLOCK_LINE_NO_ESTIMATE,
  CLOCK_LINE_RE,
  CONTROLLER_LINE_ACTING_RE,
  CONTROLLER_LINE_HELD_RE,
  createDiagnosticsOverlay,
} from '../../../public/lib/diagnostics-overlay.mjs';

const fakeClock = (read) => ({ read: () => read });
/** The controller and the load rule both publish one `state()`, so one stub serves both. */
const fakeState = (state) => ({ state: () => state });

/**
 * An ordinary acting poll, and every figure in it derived the way the controller
 * derives it: an estimate 12.3ms behind against an 8.4ms band leaves 3.9ms of
 * excess, which closes in 390ms at the 0.01 rate authority and asks for a
 * correction of 3.9/4000 on the 4s time constant.
 */
const makeControllerState = (overrides = {}) => ({
  rate: 1.000975,
  estimateMs: -12.3,
  bandMs: 8.4,
  fastestCloseMs: 390,
  windowRecords: 24,
  mode: 'correcting',
  reason: null,
  ...overrides,
});

/** Every non-acting exit runs through `hold()`, which names a reason and acts on nothing. */
const makeHeldState = (overrides = {}) => makeControllerState({
  rate: 1,
  estimateMs: null,
  bandMs: null,
  fastestCloseMs: null,
  ...overrides,
});

function makeOverlay({
  clockState = { offsetMs: null, halfWidthMs: null, sampleCount: 0 },
  controllerState = makeControllerState(),
  playbackState = { playing: true, missing: null },
} = {}) {
  const log = createDriftLog();
  const overlay = createDiagnosticsOverlay({
    clock: fakeClock(clockState),
    controller: fakeState(controllerState),
    log,
    playback: fakeState(playbackState),
  });
  return { log, overlay };
}

/** RESTATED HERE, never imported from the module under check — an expectation built
 *  by the code it is checking passes whatever that code decides a number looks like. */
const signed = (ms) => `${ms >= 0 ? '+' : ''}${ms.toFixed(1)}ms`;
const other = (shape) => (shape === CONTROLLER_LINE_HELD_RE ? CONTROLLER_LINE_ACTING_RE : CONTROLLER_LINE_HELD_RE);

const controllerCases = [
  {
    name: 'diagnostics overlay: waiting with no clock names its reason',
    state: makeHeldState({ mode: 'waiting', reason: 'no-clock', windowRecords: 0 }),
    expected: 'controller: rate 1.000000 · waiting · no-clock over 0 frames',
    shape: CONTROLLER_LINE_HELD_RE,
  },
  {
    // `fastestCloseMs` SURVIVES THIS HOLD and the other two null it, which is
    // why the line may not read it: beside a stale mode it is a live-looking
    // figure from an earlier second (design.md D1).
    name: 'diagnostics overlay: stale with no records names its reason',
    state: makeHeldState({ mode: 'stale', reason: 'no-records', fastestCloseMs: 30000, windowRecords: 24 }),
    expected: 'controller: rate 1.000000 · stale · no-records over 24 frames',
    shape: CONTROLLER_LINE_HELD_RE,
  },
  {
    // EVERY FIELD BUT THE REASON AGREES WITH THE no-clock CASE ABOVE, which is
    // the whole thing the uniqueness check below tests. Let this one differ in
    // its frame count or carry figures the other nulls, and the two lines
    // differ by THAT instead — and the check passes against a builder that
    // renders no reason at all. The agreement is faithful: an empty window
    // leaves the controller no estimate to have counted, so it reports this
    // reason with the same nulls and the same 0 the no-clock arm reports.
    name: 'diagnostics overlay: waiting with too few records names its reason',
    state: makeHeldState({ mode: 'waiting', reason: 'too-few-records', windowRecords: 0 }),
    expected: 'controller: rate 1.000000 · waiting · too-few-records over 0 frames',
    shape: CONTROLLER_LINE_HELD_RE,
  },
  {
    // 687.9ms of excess takes 68.79s at the rate authority, which is past the
    // 60s close budget — the figures are what MAKE this mode, not decoration
    // beside it, and the correction they ask for saturates at the authority.
    name: 'diagnostics overlay: beyond rate authority reports its estimate and close',
    state: makeControllerState({
      rate: 0.99,
      mode: 'beyond-rate-authority',
      estimateMs: 700.2,
      bandMs: 12.3,
      fastestCloseMs: 68790,
      windowRecords: 20,
    }),
    expected: 'controller: rate 0.990000 · beyond-rate-authority · estimate +700.2ms, deadband 12.3ms, closes in 68.8s over 20 frames',
    shape: CONTROLLER_LINE_ACTING_RE,
  },
  {
    name: 'diagnostics overlay: correcting reports its estimate and close',
    state: makeControllerState(),
    expected: 'controller: rate 1.000975 · correcting · estimate -12.3ms, deadband 8.4ms, closes in 0.4s over 24 frames',
    shape: CONTROLLER_LINE_ACTING_RE,
  },
  {
    // INSIDE THE BAND THERE IS NO EXCESS, so the close is 0.0s rather than
    // absent: the controller computes it on every acting poll before it picks a
    // mode, and a line that omitted it here would be reporting a state that
    // arm cannot produce.
    name: 'diagnostics overlay: settled remains distinguishable',
    state: makeControllerState({ rate: 1, mode: 'settled', estimateMs: 0, fastestCloseMs: 0, windowRecords: 16 }),
    expected: 'controller: rate 1.000000 · settled · estimate +0.0ms, deadband 8.4ms, closes in 0.0s over 16 frames',
    shape: CONTROLLER_LINE_ACTING_RE,
  },
  {
    name: 'diagnostics overlay: declining reports the estimate it declined to act on',
    state: makeControllerState({ rate: 1, mode: 'declining', estimateMs: 1.2, bandMs: 9.7, fastestCloseMs: 0, windowRecords: 8 }),
    expected: 'controller: rate 1.000000 · declining · estimate +1.2ms, deadband 9.7ms, closes in 0.0s over 8 frames',
    shape: CONTROLLER_LINE_ACTING_RE,
  },
];

export default async function diagnosticsOverlaySuite() {
  await check('diagnostics overlay: clock line covers no estimate and signed estimates', async () => {
    const noEstimate = makeOverlay();
    assertEqual(noEstimate.overlay.lines().clock, CLOCK_LINE_NO_ESTIMATE, 'no estimate uses the published clock line');

    const positive = makeOverlay({
      clockState: { offsetMs: 12, halfWidthMs: 3.4, sampleCount: 12 },
    }).overlay.lines().clock;
    assertEqual(positive, 'clock: +12.0ms ± 3.4ms (12 samples)', 'positive offset keeps the sign and trailing zero');
    assert(CLOCK_LINE_RE.test(positive), 'positive estimate matches the published clock pattern');

    const negative = makeOverlay({
      clockState: { offsetMs: -4.2, halfWidthMs: 3.4, sampleCount: 12 },
    }).overlay.lines().clock;
    assertEqual(negative, 'clock: -4.2ms ± 3.4ms (12 samples)', 'negative offset keeps its minus sign');
    assert(CLOCK_LINE_RE.test(negative), 'negative estimate matches the published clock pattern');
  });

  const controllerLines = controllerCases.map((testCase) =>
    makeOverlay({ controllerState: testCase.state }).overlay.lines().controller,
  );
  await check('diagnostics overlay: every controller mode and reason has a distinct line', async () => {
    assertEqual(new Set(controllerLines).size, controllerLines.length, 'controller diagnoses remain distinguishable');
  });

  for (const [index, testCase] of controllerCases.entries()) {
    await check(testCase.name, async () => {
      const line = controllerLines[index];
      assertEqual(line, testCase.expected, 'controller line has the exact constructed shape');
      assert(testCase.shape.test(line), 'controller line matches the shape its own arm publishes');
      // THE TWO SHAPES MUST REFUSE EACH OTHER, or publishing two bought nothing:
      // a consumer asking "is this client acting on a measurement" would be
      // satisfied by a page that has held since it loaded.
      assert(!other(testCase.shape).test(line), 'the other published shape refuses this line');
    });
  }

  await check('diagnostics overlay: a hold does not render figures from an acting poll', async () => {
    // THE ONE HOLD THAT REACHES THE LINE WITH LIVE FIGURES. `no-clock` and
    // `stale` both leave the controller with no estimate to have counted, so
    // for those the renderer would print nothing whether it read the reason or
    // not; too few records inside a NON-EMPTY window is the state that tells a
    // builder branching on the reason from one that does not.
    const line = makeOverlay({
      controllerState: makeControllerState({
        rate: 1,
        mode: 'waiting',
        reason: 'too-few-records',
        estimateMs: -45,
        bandMs: 15,
        fastestCloseMs: 3000,
        windowRecords: 6,
      }),
    }).overlay.lines().controller;
    assertEqual(line, 'controller: rate 1.000000 · waiting · too-few-records over 6 frames', 'a hold reports its reason instead of figures it did not act on');
    assert(CONTROLLER_LINE_HELD_RE.test(line), 'held controller line matches the published held shape');
    assert(!CONTROLLER_LINE_ACTING_RE.test(line), 'a hold is refused by the acting shape');
  });

  await check('diagnostics overlay: a figure the controller cannot produce is neither rendered nor vouched for', async () => {
    // Not a state `drift-controller.mjs` can reach — an acting poll computes the
    // estimate, the band and the close together — so this covers the renderer's
    // guard from BOTH sides: no NaN reaches the page, and the stump it falls
    // back to is refused by every shape this module publishes, rather than
    // admitted by a pattern loose enough to hold it.
    const line = makeOverlay({
      controllerState: makeControllerState({ rate: 1, estimateMs: Number.NaN, bandMs: Number.POSITIVE_INFINITY, fastestCloseMs: Number.NaN }),
    }).overlay.lines().controller;
    assert(!/NaN|Infinity|undefined/.test(line), 'non-finite figures never reach the page');
    assertEqual(line, 'controller: rate 1.000000 · correcting over 24 frames', 'the guard drops the figures rather than printing them');
    assert(!CONTROLLER_LINE_ACTING_RE.test(line), 'a correcting line without its figures is not a published acting shape');
    assert(!CONTROLLER_LINE_HELD_RE.test(line), 'and it is not a published held shape either');
  });

  await check('diagnostics overlay: rendered drift summary uses the published summary', async () => {
    const values = [-12.34, 4, 8, 100];
    const { log, overlay } = makeOverlay();
    for (const driftMs of values) log.add({ ok: true, record: { driftMs, clock: {} } });

    const summary = log.summary();
    const line = overlay.lines().drift;
    const expected = `drift: ${signed(values[values.length - 1])} · rolling window over the last ${summary.framesHeld} frames: median ${signed(summary.medianDriftMs)}, p99 ${signed(summary.p99DriftMs)}`;
    assertEqual(line, expected, 'drift text mirrors the rolling summary');
    assert(DRIFT_LINE_RE.test(line), 'drift text matches the published pattern');
  });

  await check('diagnostics overlay: one paint consumes the drift read-out once', async () => {
    const { overlay } = makeOverlay();
    const first = overlay.lines();
    assertEqual(first.drift, 'drift: no new records — nothing recorded yet', 'first paint reports the empty log');
    const second = overlay.lines();
    assertEqual(second.drift, 'drift: no new records — no frames offered — rVFC is silent', 'second paint reports no new records');
  });
}
