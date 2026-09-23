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
import { recordRig } from '../drift-plant.mjs';
import { createDriftLog } from '../../../public/lib/frame-drift.mjs';
import { DRIFT_LINE_RE } from '../../../public/lib/drift-readout.mjs';
import {
  CLOCK_LINE_NO_ESTIMATE,
  CLOCK_LINE_RE,
  CONTROLLER_LINE_ACTUATOR_LIMIT_RE,
  CONTROLLER_LINE_BEYOND_RE,
  CONTROLLER_LINE_BEYOND_UNAVAILABLE_RE,
  CONTROLLER_LINE_BUDGET_RE,
  CONTROLLER_LINE_CORRECTING_RE,
  CONTROLLER_LINE_ACTING_RE,
  CONTROLLER_LINE_MEASUREMENT_LIMIT_RE,
  CONTROLLER_LINE_SETTLED_RE,
  CONTROLLER_LINE_HELD_RE,
  CONTROLLER_LINE_TREATMENT_FAULT_RE,
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
const makeControllerState = ({ bandMs = 8.4, ...overrides } = {}) => ({
  rate: 1.000975,
  estimateMs: -12.3,
  bandMs,
  spreadMs: 2.1,
  halfWidthMs: bandMs,
  measurementLimit: 'clock',
  // f IS ZERO ON THIS BRANCH, so S is U and the accepted threshold is the band
  // itself — derived here from the case's own input rather than read back out of
  // the controller, which is what makes these expectations independent of it.
  actuatorAllowanceMs: 0,
  requiredStoppingThresholdMs: bandMs,
  stoppingThresholdMs: bandMs,
  thresholdUsable: true,
  fastestCloseMs: 390,
  settings: { CLOSE_BUDGET_MS: 60000, MAX_STOPPING_THRESHOLD_MS: 20 },
  windowRecords: 24,
  mode: 'correcting',
  reason: null,
  ...overrides,
});

/**
 * Every non-acting exit runs through `hold()`, which names a reason and acts on
 * nothing. A hold publishes no accepted threshold and no close: those are
 * answers about an error this poll would act on, and it acted on none.
 */
const makeHeldState = (overrides = {}) => makeControllerState({
  rate: 1,
  estimateMs: null,
  bandMs: null,
  spreadMs: null,
  halfWidthMs: null,
  measurementLimit: null,
  requiredStoppingThresholdMs: null,
  stoppingThresholdMs: null,
  thresholdUsable: false,
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

/** Build the no-finite-close fixture through the shipped controller. At zero
 * rate authority, eight real records at -200ms qualify a usable 4ms threshold,
 * but the shortest close is unavailable rather than an invented infinity. */
const makeZeroAuthorityState = () => {
  const rig = recordRig({ halfWidthMs: 4, settings: { MAX_RATE_DEVIATION: 0 } });
  for (let i = 0; i < 8; i++) rig.add(-200);
  return rig.controller.poll();
};

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
    // The stale cutoff empties the control window, so this hold has no estimate
    // to have counted while its older records still fill the rolling one — the
    // frame count is the only figure it can carry.
    name: 'diagnostics overlay: stale with no records names its reason',
    state: makeHeldState({ mode: 'stale', reason: 'no-records', windowRecords: 24 }),
    expected: 'controller: rate 1.000000 · stale · no-records over 24 frames',
    shape: CONTROLLER_LINE_HELD_RE,
  },
  {
    // EVERY FIELD BUT THE REASON AGREES WITH THE no-clock CASE ABOVE, and must:
    // let this one differ in its frame count or carry figures the other nulls,
    // and the two lines differ by THAT instead — so the uniqueness check below
    // passes against a builder that renders no reason at all (CONSTRAINTS.md →
    // *Verification*). The agreement is faithful: an empty window leaves the
    // controller no estimate to have counted.
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
    expected: 'controller: rate 0.990000 · beyond-rate-authority · error +700.2ms · U 12.3ms · actuator allowance 0.0ms · stopping threshold 12.3ms · close lower bound 68.8s (close budget 60.0s) over 20 frames',
    shape: CONTROLLER_LINE_BEYOND_RE,
  },
  {
    // This state is produced by a real f=0 controller, not by combining fields
    // in a renderer fixture: an error outside U with no rate authority has no
    // finite close lower bound to print.
    name: 'diagnostics overlay: zero rate authority publishes an unavailable close bound',
    state: makeZeroAuthorityState(),
    expected: 'controller: rate 1.000000 \u00b7 beyond-rate-authority \u00b7 error -200.0ms \u00b7 U 4.0ms \u00b7 actuator allowance 0.0ms \u00b7 stopping threshold 4.0ms \u00b7 close lower bound unavailable (close budget 60.0s) over 8 frames',
    shape: CONTROLLER_LINE_BEYOND_UNAVAILABLE_RE,
  },
  {
    name: 'diagnostics overlay: correcting reports its estimate and close',
    state: makeControllerState(),
    expected: 'controller: rate 1.000975 · correcting · error -12.3ms · U 8.4ms · actuator allowance 0.0ms · stopping threshold 8.4ms · close lower bound 0.4s (close budget 60.0s) over 24 frames',
    shape: CONTROLLER_LINE_CORRECTING_RE,
  },
  {
    // INSIDE THE BAND THERE IS NO EXCESS, so the close is 0.0s rather than
    // absent: the controller computes it on every acting poll before it picks a
    // mode, and a line that omitted it here would be reporting a state that
    // arm cannot produce.
    name: 'diagnostics overlay: settled remains distinguishable',
    state: makeControllerState({ rate: 1, mode: 'settled', estimateMs: 0, fastestCloseMs: 0, windowRecords: 16 }),
    expected: 'controller: rate 1.000000 · settled · error +0.0ms · U 8.4ms · actuator allowance 0.0ms · stopping threshold 8.4ms · applied rate 1.000000 over 16 frames',
    shape: CONTROLLER_LINE_SETTLED_RE,
  },
  {
    // THE CASE THAT TELLS THE TWO RENDERERS APART. Declining now names the limit
    // that held it, so a line built as `reason ?? figures` prints
    // `· measurement-limit` here and drops the estimate the page exists to show.
    name: 'diagnostics overlay: declining reports the estimate it declined to act on',
    state: makeControllerState({ rate: 1, mode: 'declining', reason: 'measurement-limit', estimateMs: 1.2, bandMs: 9.7, fastestCloseMs: 0, windowRecords: 8 }),
    expected: 'controller: rate 1.000000 · declining · measurement-limit · measurement arm clock · error +1.2ms · U 9.7ms · actuator allowance 0.0ms · stopping threshold 9.7ms over 8 frames',
    shape: CONTROLLER_LINE_MEASUREMENT_LIMIT_RE,
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
      const publishedShape = testCase.shape === CONTROLLER_LINE_HELD_RE
        ? CONTROLLER_LINE_HELD_RE : CONTROLLER_LINE_ACTING_RE;
      assert(publishedShape.test(line), 'the browser consumer accepts the complete controller line');
      assert(!publishedShape.test(`BROKEN ${line}`), 'the browser consumer refuses a prefixed line');
      assert(!publishedShape.test(`${line} NaN`), 'the browser consumer refuses trailing corrupt output');
      if (testCase.shape === CONTROLLER_LINE_BEYOND_UNAVAILABLE_RE) {
        assert(CONTROLLER_LINE_ACTING_RE.test(line), 'the unavailable-close beyond-authority line is classified by the acting union');
      }
      // THE TWO SHAPES MUST REFUSE EACH OTHER, or publishing two bought nothing:
      // a consumer asking "is this client acting on a measurement" would be
      // satisfied by a page that has held since it loaded.
      assert(!other(testCase.shape).test(line), 'the other published shape refuses this line');
    });
  }

  await check('diagnostics overlay: a latched treatment fault has its own line and presents nothing as current', async () => {
    // The adapter view that replaces a settled kernel snapshot once the pitch
    // treatment is lost (playback-treatment.mjs). The settled state rides along
    // as `historical`, and the line must not read it.
    const historical = makeControllerState({ rate: 1, mode: 'settled', estimateMs: 0, fastestCloseMs: 0, windowRecords: 16 });
    const faulted = (overrides) => ({ mode: 'treatment-fault', reason: 'pitch-lost', unity: 'restored', rate: 1, thresholdUsable: false, stoppingThresholdMs: null, fastestCloseMs: null, controllerActive: false, settings: historical.settings, polls: 40, historical, ...overrides });
    const restored = makeOverlay({ controllerState: faulted() }).overlay.lines().controller;
    assertEqual(restored, 'controller: rate 1.000000 · treatment-fault · pitch-lost · unity restored · synchronization suspended until reload', 'the exact fault line');
    const failed = makeOverlay({ controllerState: faulted({ reason: 'pitch-unreadable', unity: 'unity-restore-failed', rate: null }) }).overlay.lines().controller;
    assertEqual(failed, 'controller: rate unknown · treatment-fault · pitch-unreadable · unity restore-failed · synchronization suspended until reload', 'a failed restore says so and invents no rate');
    for (const line of [restored, failed]) {
      assert(CONTROLLER_LINE_TREATMENT_FAULT_RE.test(line), 'the fault shape accepts it');
      assert(!CONTROLLER_LINE_ACTING_RE.test(line) && !CONTROLLER_LINE_HELD_RE.test(line), 'neither existing shape does');
      assert(!line.includes('settled'), 'the historical settled mode is not presented as current');
      assert(!CONTROLLER_LINE_TREATMENT_FAULT_RE.test(`BROKEN ${line}`) && !CONTROLLER_LINE_TREATMENT_FAULT_RE.test(`${line} NaN`), 'prefixed or trailing corruption is refused');
    }
    assert(!CONTROLLER_LINE_TREATMENT_FAULT_RE.test('controller: rate 1.000000 · treatment-fault · anything · unity restored · synchronization suspended until reload'), 'an unnamed reason is refused');
    for (const line of controllerLines) assert(!CONTROLLER_LINE_TREATMENT_FAULT_RE.test(line), 'no existing branch matches the fault shape');
  });
  await check('diagnostics overlay: a hold does not render the components it did not act on', async () => {
    // THE ONE HOLD THAT REACHES THE LINE WITH MEASUREMENT COMPONENTS. Too few
    // records inside a NON-EMPTY window still computes an estimate, a dispersion
    // arm and the U and required S over them — it is only the ACCEPTANCE the
    // hold withholds, so `thresholdUsable` is false and there is no close. That
    // makes it the state that tells a renderer keyed on usability from one that
    // prints whatever figures it finds.
    const line = makeOverlay({
      controllerState: makeControllerState({
        rate: 1,
        mode: 'waiting',
        reason: 'too-few-records',
        estimateMs: -45,
        bandMs: 15,
        spreadMs: 15,
        measurementLimit: 'clock-and-dispersion',
        stoppingThresholdMs: null,
        thresholdUsable: false,
        fastestCloseMs: null,
        windowRecords: 6,
      }),
    }).overlay.lines().controller;
    assertEqual(line, 'controller: rate 1.000000 · waiting · too-few-records over 6 frames', 'a hold reports its reason instead of figures it did not act on');
    assert(!line.includes('-45.0ms') && !line.includes('15.0ms'), 'the provisional components a hold retains do not reach the line');
    assert(CONTROLLER_LINE_HELD_RE.test(line), 'held controller line matches the published held shape');
    assert(!CONTROLLER_LINE_ACTING_RE.test(line), 'a hold is refused by the acting shape');
  });

  // THE SIGNED FIELD AND THE MAGNITUDE FIELDS ARE NOT THE SAME SHAPE.
  // `error` is the controller's one signed figure; U, the actuator allowance, the
  // accepted and required thresholds and the two close durations are magnitudes
  // that cannot be negative. A pattern admitting a sign on those five accepts a
  // page whose controller has come apart, and `verify-browser` asserts rendered
  // text against exactly these patterns — so the fixtures below are the
  // deliberately broken lines the browser pass must never accept, alongside the
  // real lines it must.
  await check('diagnostics overlay: the published patterns refuse a negative magnitude and keep the signed error', async () => {
    // Rendered through the real renderer, not written out: two branches the case
    // table above does not reach, so every arm carrying a magnitude is covered.
    const budget = makeOverlay({
      controllerState: makeHeldState({
        mode: 'resolution-budget-hold', reason: 'stopping-threshold-over-budget',
        requiredStoppingThresholdMs: 20.96, windowRecords: 9,
      }),
    }).overlay.lines().controller;
    const actuator = makeOverlay({
      controllerState: makeControllerState({
        rate: 1.00001, mode: 'declining', reason: 'actuator-limit',
        estimateMs: -30.5, bandMs: 6.2, fastestCloseMs: 2430, windowRecords: 12,
      }),
    }).overlay.lines().controller;
    assertEqual(budget, 'controller: rate 1.000000 · resolution-budget-hold · stopping-threshold-over-budget · required S 21.0ms · ceiling 20.0ms refused over 9 frames', 'the over-budget hold line');
    assertEqual(actuator, 'controller: rate 1.000010 · declining · actuator-limit · error -30.5ms · U 6.2ms · actuator allowance 0.0ms · stopping threshold 6.2ms over 12 frames', 'the actuator-limit line');
    assert(CONTROLLER_LINE_BUDGET_RE.test(budget), 'the budget shape accepts its own rendered line');
    assert(CONTROLLER_LINE_ACTUATOR_LIMIT_RE.test(actuator), 'the actuator-limit shape accepts its own rendered line');

    const MAGNITUDES = ['U ', 'actuator allowance ', 'stopping threshold ', 'required S ', 'close lower bound ', 'close budget '];
    const lines = [
      ...controllerCases.filter((testCase) => testCase.shape !== CONTROLLER_LINE_HELD_RE)
        .map((testCase, index) => [testCase.shape, controllerLines[controllerCases.indexOf(testCase)], testCase.name.slice(0, 40) + index]),
      [CONTROLLER_LINE_BUDGET_RE, budget, 'budget'],
      [CONTROLLER_LINE_ACTUATOR_LIMIT_RE, actuator, 'actuator-limit'],
    ];
    let negated = 0;
    for (const [shape, line, label] of lines) {
      // VALID FIRST. A refusal check is worth nothing beside a pattern that
      // refuses the healthy line too.
      assert(shape.test(line), `${label}: the branch shape accepts the real line`);
      assert(CONTROLLER_LINE_ACTING_RE.test(line), `${label}: so does the acting union`);
      for (const field of MAGNITUDES) {
        const at = line.indexOf(field);
        if (at === -1) continue;
        const broken = `${line.slice(0, at + field.length)}-${line.slice(at + field.length)}`;
        if (broken === line || /unavailable/.test(line.slice(at + field.length, at + field.length + 12))) continue;
        negated += 1;
        assert(!shape.test(broken), `${label}: a negative ${field.trim()} is refused by the branch shape`);
        assert(!CONTROLLER_LINE_ACTING_RE.test(broken), `${label}: and by the acting union`);
      }
    }
    assertEqual(negated, 24, 'every magnitude field in every acting arm was negated and refused');

    // The signed field keeps both signs, and now REQUIRES one: `signed()` always
    // writes a `+` or a `-`, so a line with a bare error magnitude is no more a
    // page this controller painted than a negative U is.
    const correcting = controllerLines[controllerCases.findIndex((testCase) => testCase.shape === CONTROLLER_LINE_CORRECTING_RE)];
    const beyond = controllerLines[controllerCases.findIndex((testCase) => testCase.shape === CONTROLLER_LINE_BEYOND_RE)];
    assert(correcting.includes('error -12.3ms') && CONTROLLER_LINE_CORRECTING_RE.test(correcting), 'a negative error is accepted');
    assert(beyond.includes('error +700.2ms') && CONTROLLER_LINE_BEYOND_RE.test(beyond), 'a positive error is accepted');
    const unsigned = correcting.replace('error -12.3ms', 'error 12.3ms');
    assert(!CONTROLLER_LINE_CORRECTING_RE.test(unsigned) && !CONTROLLER_LINE_ACTING_RE.test(unsigned), 'an unsigned error is refused');
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

  await check('diagnostics overlay: the drift line names paused, preparing, missing state, and host link', async () => {
    // The four statuses differ only in the fields the scheduled start sets for them.
    const base = { playing: false, missing: null, waiting: null, retargets: 2 };
    const statuses = [
      { ...base, waiting: 'room-paused' },
      { ...base, waiting: 'preparing' },
      { ...base, missing: 'playback-state' },
      { ...base, missing: 'host-link' },
    ];
    const lines = statuses.map((playbackState) => makeOverlay({ playbackState }).overlay.lines().drift);
    assertEqual(lines[0], 'drift: not playing — room paused', 'paused');
    assertEqual(lines[1], 'drift: not playing — preparing start (retargets 2)', 'preparing with its retargets');
    assertEqual(lines[2], 'drift: not playing — waiting for playback-state', 'missing state');
    assertEqual(lines[3], 'drift: not playing — waiting for host-link', 'missing host link');
  });

  await check('diagnostics overlay: an in-threshold hold with no correction renders an acting shape (O1 input)', async () => {
    // Through the shipped controller, as a scheduled start landing in sync would
    // reach it: records inside the threshold from the first poll, no correction.
    const rig = recordRig({ halfWidthMs: 4 });
    for (let i = 0; i < 12; i++) rig.add(1);
    const state = rig.controller.poll();
    assert(Number.isFinite(state.estimateMs) && state.thresholdUsable === true, `the hold has a usable threshold: ${JSON.stringify({ mode: state.mode, reason: state.reason })}`);
    assert(Math.abs(state.estimateMs) <= state.stoppingThresholdMs, 'the estimate is inside the accepted threshold');
    assertEqual(state.correctionsApplied, 0, 'no correction was applied');
    assertEqual(`${state.mode}/${state.reason}`, 'declining/measurement-limit', 'the controller publishes declining at its measurement limit');
    const line = makeOverlay({ controllerState: state }).overlay.lines().controller;
    assert(CONTROLLER_LINE_ACTING_RE.test(line), `the in-threshold hold matches CONTROLLER_LINE_ACTING_RE: ${line}`);
  });

  await check('diagnostics overlay: one paint consumes the drift read-out once', async () => {
    const { overlay } = makeOverlay();
    const first = overlay.lines();
    assertEqual(first.drift, 'drift: no new records — nothing recorded yet', 'first paint reports the empty log');
    const second = overlay.lines();
    assertEqual(second.drift, 'drift: no new records — no frames offered — rVFC is silent', 'second paint reports no new records');
  });
}
