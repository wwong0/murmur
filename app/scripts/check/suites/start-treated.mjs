// scripts/check/suites/start-treated.mjs
//
// The treated condition (executor-spec.md §13.1, as O2 option 1' replaced its
// condition 2) and its negative control (task 13.3). Pure — no server, no
// browser, no Chrome.
//
// The control runs against the RETAINED baseline `summary.json` on disk, not
// against a fixture: task 13.3 requires it to be green, with the real frozen
// figures, before any treated start is run. The gate pairs below are fixtures
// differing in the one figure their gate reads (R6).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, assert, assertEqual, skipWithoutResults } from '../harness.mjs';
import { mechanismCheck, mechanismControl, reduceTreated } from '../../start-timing.mjs';
import { PRESENTATION_ADVANCE_MS } from '../../../public/lib/playback-leads.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** The baseline the treated run is matched against, frozen before task 12 landed. */
const BASELINE_DIR = 'results/5-start-diagnostic-2026-09-17T06-25-21.953Z';
const json = (value) => JSON.stringify(value);

function readBaseline() {
  const file = path.join(APP_DIR, BASELINE_DIR, 'summary.json');
  if (!fs.existsSync(file)) throw new Error(`the retained baseline summary is missing: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// A constructed treated capture, in the shape `reduceStart` publishes and
// `reduceTreated` reads. Eight starts, four phases over the two conditions.
const CONDITIONS = ['resume', 'load'];
const PHASES = [0, 0.25, 0.5, 0.75];
const FRAME_INTERVAL_MS = 40;
const DISPLAY_CADENCE_MS = 16;
const HALF_WIDTH_MS = 4;
/** U = 16/2 + 40/2 + 4. */
const U = 32;

const labels = CONDITIONS.flatMap((condition) => PHASES.map((phase) => `${condition}-${phase}`));

const startAt = (label, medianMs, overrides = {}) => ({
  label,
  condition: label.split('-')[0],
  phase: Number(label.split('-')[1]),
  dispatchMs: 5,
  maxHalfWidthMs: HALF_WIDTH_MS,
  advanceMs: PRESENTATION_ADVANCE_MS,
  residual: { status: Math.abs(medianMs) <= FRAME_INTERVAL_MS ? 'met' : 'missed', medianMs, count: 24 },
  tailMs: medianMs,
  unusable: [],
  ...overrides,
});

const leadAt = (label, medianMs, overrides = {}) => ({
  label, status: medianMs <= U ? 'held' : 'lead', medianMs, count: 24, uncertaintyMs: U, ...overrides,
});

/**
 * A whole treated capture from eight medians, with the baseline it is judged
 * against. The baseline medians are `treated − advance` by construction, so the
 * mechanism check holds unless a case deliberately moves one figure.
 */
function treated({ medians, advanceMs = 20, baselineOverrides = {}, starts: startOverrides = {}, leads: leadOverrides = {}, ...rest }) {
  const baselineMedians = medians.map((value) => value - advanceMs);
  const sorted = [...baselineMedians].sort((a, b) => a - b);
  const baselineAggregate = (sorted[3] + sorted[4]) / 2;
  return reduceTreated({
    starts: labels.map((label, index) => startAt(label, medians[index], startOverrides[index] ?? {})),
    leads: labels.map((label, index) => leadAt(label, medians[index], leadOverrides[index] ?? {})),
    frameIntervalMs: FRAME_INTERVAL_MS,
    displayCadenceMs: DISPLAY_CADENCE_MS,
    baseline: { aggregate: baselineAggregate, medians: baselineMedians, Um: 5, advanceMs, ...baselineOverrides },
    ...rest,
  });
}

/** Eight medians centred on `centre`, spread `span`, so every start is distinct. */
const spreadAround = (centre, span) => PHASES.concat(PHASES).map((_, index) => centre - span / 2 + (span * index) / 7);

const gateOf = (result, name) => result.gates.find((entry) => entry.name === name) ?? null;

export default async function startTreatedSuite() {
  if (skipWithoutResults('start-treated')) return;
  await check('start treated: the negative control goes red on the retained baseline, and its positive twin green', async () => {
    const baseline = readBaseline();
    // The control is only a control if it runs on the real frozen figures.
    assertEqual(baseline.verdict, 'SPREAD', 'the retained baseline is the SPREAD capture, unchanged');
    assertEqual(baseline.medians.length, 8, 'with its eight per-start medians');
    assert(Number.isFinite(baseline.Um) && Number.isFinite(baseline.aggregate), 'and a frozen Um and aggregate');

    const control = mechanismControl({
      baselineMedians: baseline.medians, baselineAggregate: baseline.aggregate,
      advanceMs: PRESENTATION_ADVANCE_MS, Um: baseline.Um,
    });
    assertEqual(control.negative.held, false, 'the unchanged baseline population is REJECTED by the mechanism check');
    assertEqual(control.positive.held, true, 'the same population shifted by the advance is accepted');
    assertEqual(control.negative.deltaMs, PRESENTATION_ADVANCE_MS, 'the negative control misses by exactly the advance');
    assertEqual(control.positive.deltaMs, 0, 'and the positive twin by nothing');
    assertEqual(control.power, true, `the advance has the power to be separated: ${PRESENTATION_ADVANCE_MS} >= 2 x ${baseline.Um}`);
    assertEqual(control.held, true, 'so the control is green and a treated run may be started');
    assert(control.powerInputs.marginMs > 0, `with margin ${control.powerInputs.marginMs}ms over 2 x Um`);
  });

  await check('start treated: the control refuses an advance too small to separate, and a tolerance that swallows it', async () => {
    const baseline = readBaseline();
    const control = (overrides) => mechanismControl({
      baselineMedians: baseline.medians, baselineAggregate: baseline.aggregate,
      advanceMs: PRESENTATION_ADVANCE_MS, Um: baseline.Um, ...overrides,
    });
    // Two-sided on the power bar, one thousandth either side of 2 x Um.
    assertEqual(control({ advanceMs: 2 * baseline.Um }).power, true, 'exactly 2 x Um has power');
    assertEqual(control({ advanceMs: 2 * baseline.Um - 0.001 }).power, false, 'a thousandth under it does not');
    assertEqual(control({ advanceMs: 2 * baseline.Um - 0.001 }).held, false, 'and the control refuses');
    // A tolerance wide enough to accept an unchanged population is exactly the
    // one-sided invariant §13.1 exists to prevent.
    assertEqual(control({ Um: PRESENTATION_ADVANCE_MS }).negative.held, true, 'a Um as wide as the advance would accept no change at all');
    assertEqual(control({ Um: PRESENTATION_ADVANCE_MS }).held, false, 'so the control reports itself unable to discriminate');
    for (const broken of [{ advanceMs: Number.NaN }, { Um: Number.NaN }, { baselineAggregate: Number.NaN }, { baselineMedians: [] }]) {
      assertEqual(control(broken).held, false, `${json(Object.keys(broken))} non-finite is not a pass`);
    }

    // Power alone is not the requirement. Exactly on all three bars at once, the
    // check accepts BOTH outcomes — an unchanged population and a moved one —
    // and a control that cannot say no does not get to say yes.
    const both = mechanismControl({ baselineMedians: [-10, -10, -10, -10], baselineAggregate: -15, advanceMs: 10, Um: 5 });
    assertEqual(both.negative.held, true, 'here the unchanged population is accepted');
    assertEqual(both.positive.held, true, 'and so is the shifted one');
    assertEqual(both.power, true, 'with the advance at exactly 2 x Um, so power holds');
    assertEqual(both.held, false, 'and the control still refuses, because it did not go red where it had to');
  });

  await check('start treated: every condition holds, and the verdict is REPAIRED', async () => {
    const result = treated({ medians: spreadAround(0, 14) });
    assertEqual(result.verdict, 'REPAIRED', `all conditions held: ${json(result.gates.filter((g) => !g.held).map((g) => g.name))}`);
    assertEqual(result.reason, null, 'with no stop code');
    assertEqual(json(result.gates.map((entry) => entry.name)), json(['T-CONTROL', 'T-G0', 'T-U', 'T1', 'T2a', 'T2b', 'T-IMPROVE', 'T-LEAD-BAR', 'T3', 'T4']), 'every gate was consulted, in §13.1 order');
    assert(result.gates.every((entry) => entry.held), 'and every one held');
    assertEqual(result.U, U, 'U is computed from this run own cadence, frame interval and half-width');
    assertEqual(result.Um, 5, 'and Um is the frozen baseline figure, not one from treated data');
    assertEqual(result.usableCount, 8, 'over the eight planned starts');
  });

  await check('start treated: each condition fails on its own figure, and the rule stops at the first', async () => {
    // Each case moves ONE input away from the REPAIRED case above.
    const cases = [
      ['T-CONTROL', { medians: spreadAround(0, 14), baselineOverrides: { Um: 20 } }, 'INCONCLUSIVE', 'S-ADVANCE-UNRESOLVED'],
      ['T-G0', { medians: spreadAround(0, 14), starts: { 3: { unusable: ['advance-not-applied'] } } }, 'INCONCLUSIVE', 'S-DIAG-EVIDENCE'],
      ['T-U', { medians: spreadAround(0, 14), displayCadenceMs: 200 }, 'INCONCLUSIVE', 'S-CADENCE'],
      ['T1', { medians: spreadAround(0, 14), starts: { 2: { residual: { status: 'missed', medianMs: -3.5, count: 24 } } } }, 'FAILED', 'S-RESIDUAL'],
      // T2a coincides with T1 on a well-formed population — D11's `met` IS
      // `|median| <= frameIntervalMs`. What it independently catches is a
      // summary that contradicts itself: a status of `met` beside a median the
      // bar refuses. That, and nothing weaker, is why it is asserted separately.
      ['T2a', { medians: spreadAround(0, 14), starts: { 1: { residual: { status: 'met', medianMs: -45, count: 24 } } } }, 'FAILED', 'S-ADVANCE-SPREAD'],
      // Centred on the room but spread half a frame either side: every start
      // meets D11's bar and the aggregate improved, yet one start is running a
      // quarter-frame AHEAD. That is what this bar exists for.
      ['T-LEAD-BAR', { medians: spreadAround(0, 50) }, 'FAILED', 'S-LEAD'],
      ['T3', { medians: spreadAround(0, 14), leads: { 5: { status: 'lead' } } }, 'FAILED', 'S-LEAD'],
      // The population landed well inside D11's bar and improved — but not by
      // the advance. A quieter machine or a different park phase would look
      // like this, and it is not a pass.
      ['T4', { medians: spreadAround(-10, 6), baselineOverrides: { medians: spreadAround(-40, 6), aggregate: -40 } }, 'INCONCLUSIVE', 'S-ADVANCE-UNRESOLVED'],
    ];
    for (const [name, input, verdict, reason] of cases) {
      const result = treated(input);
      assertEqual(result.verdict, verdict, `${name}: the verdict names the failure`);
      assertEqual(result.reason, reason, `${name}: under its own stop code`);
      assertEqual(gateOf(result, name)?.held, false, `${name}: is the gate that failed`);
      assertEqual(result.gates.at(-1).name, name, `${name}: and the rule stopped there rather than going on`);
    }
  });

  await check('start treated: a translation that widens the spread, and one that improves nothing, are refused', async () => {
    // T2b: same medians, a baseline whose own spread was narrower. The pair
    // differs in the baseline spread alone.
    const medians = spreadAround(0, 14);
    const wide = treated({ medians, baselineOverrides: { medians: medians.map(() => -20), aggregate: -20 } });
    assertEqual(gateOf(wide, 'T2b')?.held, false, 'a treated spread wider than the baseline plus Um is refused');
    assertEqual(wide.reason, 'S-ADVANCE-SPREAD', 'as a spread failure');
    assert(gateOf(wide, 'T2b').inputs.treatedSpread > gateOf(wide, 'T2b').inputs.bar, `${gateOf(wide, 'T2b').inputs.treatedSpread} over ${gateOf(wide, 'T2b').inputs.bar}`);

    // T-IMPROVE: the treated aggregate must have MOVED, not merely landed.
    const unmoved = reduceTreated({
      starts: labels.map((label, index) => startAt(label, spreadAround(-20, 6)[index])),
      leads: labels.map((label, index) => leadAt(label, spreadAround(-20, 6)[index])),
      frameIntervalMs: FRAME_INTERVAL_MS, displayCadenceMs: DISPLAY_CADENCE_MS,
      baseline: { aggregate: -20, medians: spreadAround(-20, 6), Um: 5, advanceMs: 0.0001 },
    });
    assertEqual(gateOf(unmoved, 'T-CONTROL')?.held, false, 'an advance of a ten-thousandth cannot be separated at all');
    assertEqual(unmoved.verdict, 'INCONCLUSIVE', 'and that is inconclusive, never a pass');

    // A population that did not move at all: identical to the baseline. The
    // improvement bar refuses it before the mechanism check is even reached, so
    // "no change" fails on the figure the repair is about.
    const unchanged = spreadAround(-30, 6);
    const noBetter = treated({ medians: unchanged, advanceMs: 20, baselineOverrides: { medians: unchanged, aggregate: -30 } });
    assertEqual(gateOf(noBetter, 'T-IMPROVE')?.held, false, 'a treated aggregate no closer to zero than the baseline is refused');
    assertEqual(noBetter.reason, 'S-ADVANCE-SPREAD', 'under the spread stop');
    assertEqual(noBetter.gates.at(-1).name, 'T-IMPROVE', 'and before the mechanism check reports on it');
  });

  await check('start treated: the mechanism check is the one arithmetic, and it is two-sided on Um', async () => {
    const at = (deltaMs) => mechanismCheck({ treatedMedians: [-10 + deltaMs, -10 + deltaMs], baselineAggregate: -30, advanceMs: 20, Um: 5 });
    assertEqual(at(0).expected, -10, 'the expected treated median is the baseline aggregate plus the advance');
    assertEqual(at(0).deltaMs, 0, 'an exact translation misses by nothing');
    assertEqual(at(5).held, true, 'exactly Um away holds');
    assertEqual(at(5.001).held, false, 'a thousandth beyond it does not');
    assertEqual(at(-5).held, true, 'and the same distance on the other side holds');
    assertEqual(at(-5.001).held, false, 'two-sided');
    assertEqual(mechanismCheck({ treatedMedians: [], baselineAggregate: -30, advanceMs: 20, Um: 5 }).held, false, 'an empty population is not a pass');
    assertEqual(mechanismCheck({ treatedMedians: [-10, Number.NaN], baselineAggregate: -30, advanceMs: 20, Um: 5 }).held, false, 'nor is one carrying a non-finite median');
  });
}
