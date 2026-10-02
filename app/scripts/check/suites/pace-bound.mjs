import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { paceBoundFraction } from '../../figures/pace-bound.mjs';
import { steadyState } from '../../figures/peer-figures.mjs';

const BARS = {
  steadyUtilisationMax: 0.90,
  steadyDownloadRatioMin: 0.95,
  steadyDownloadRatioMax: 1.25,
  steadyRealtimeMin: 0.98,
  steadyPaceBoundMax: 0.10,
};

function intervals(paceBoundMs = 15_000) {
  return [60_000, 120_000, 180_000].map((endWallMs, index) => ({
    seq: index + 1, endWallMs: endWallMs + 100, durationMs: 60_000, paceBoundMs,
  }));
}

function fixture(fraction = 0.85, overrides = {}) {
  const input = {
    condition: { bars: BARS },
    headroom: { fraction },
    hostPace: { intervals: intervals() },
    wallOffsetMs: 100,
    window: { startMs: 0, endMs: 180_000 },
    content: { segmentSizes: [1_000] },
    segmentSeconds: 1,
    ...overrides,
  };
  return {
    input,
    tags: ['c01'],
    figures: { uplinkUtilisationMean: 0.84, realtimeFactorByClient: { c01: 1 } },
    cohorts: { c01: [{ lengthBytes: 1_000 }] },
    oneViewing: { playedMediaMsByClient: { c01: { start: 0, end: 1_000 } } },
  };
}

function state(fraction = 0.85, overrides = {}) {
  return steadyState(fixture(fraction, overrides));
}

export default async function paceBoundSuite() {
  await check('pace bound: a held host fails the pace-bound steady leg', async () => {
    const result = state();
    assertEqual(result.steady, false, 'held host is not steady');
    assertEqual(result.reason, 'steady-state-pace-bound', 'pace-bound failure is named');
    assertNear(result.legs.paceBound.value, 0.25, 0, '45 seconds in a 180 second window is 0.25');
    assertEqual(result.legs.paceBound.pass, false, 'pace-bound value exceeds 0.10');
  });

  await check('pace bound: unpaced hosts leave the leg unapplied', async () => {
    const result = state('unpaced');
    assertEqual(result.steady, true, 'unpaced host uses the existing steady legs');
    assertEqual(result.legs.paceBound.applies, false, 'unpaced pace leg does not apply');
    assertEqual(result.legs.paceBound.reason, 'unpaced', 'unpaced reason is retained');
    assert(!('pass' in result.legs.paceBound), 'unpaced leg never reports a pass');
  });

  await check('pace bound: a half-covered interval weights its bound time by overlap', async () => {
    const result = paceBoundFraction({
      intervals: [
        { seq: 1, endWallMs: 1_000, durationMs: 1_000, paceBoundMs: 0 },
        { seq: 2, endWallMs: 1_500, durationMs: 1_000, paceBoundMs: 800 },
        { seq: 3, endWallMs: 2_500, durationMs: 1_000, paceBoundMs: 0 },
      ],
      window: { startMs: 1_000, endMs: 2_000 }, wallOffsetMs: 0,
    });
    assertNear(result.pacedMs, 400, 0, '800ms bound over a 500ms overlap is 400ms');
    assertNear(result.coveredMs, 1_000, 0, 'neighboring intervals cover the whole window');
    assertNear(result.value, 0.4, 0, '400ms over a 1000ms window is 0.4');
  });

  await check('pace bound: incomplete evidence is unavailable, not zero', async () => {
    const result = paceBoundFraction({ intervals: [], window: { startMs: 0, endMs: 180_000 }, wallOffsetMs: 0 });
    assertEqual(result.value, null, 'empty evidence has no value');
    assertEqual(result.reason, 'pace-evidence-incomplete', 'empty evidence is refused by name');
  });

  await check('pace bound: gaps over two seconds refuse the window', async () => {
    const result = paceBoundFraction({
      intervals: [
        { seq: 1, endWallMs: 1_000, durationMs: 1_000, paceBoundMs: 100 },
        { seq: 2, endWallMs: 5_001, durationMs: 1_000, paceBoundMs: 100 },
      ],
      window: { startMs: 0, endMs: 5_001 }, wallOffsetMs: 0,
    });
    assertEqual(result.value, null, 'a gap over 2000ms has no fraction');
    assertEqual(result.reason, 'pace-evidence-incomplete', 'the gap is an evidence refusal');
  });

  await check('pace bound: impossible interval values are hard errors', async () => {
    for (const invalid of [
      [{ seq: 1, endWallMs: 1, durationMs: 0, paceBoundMs: 0 }],
      [{ seq: 1, endWallMs: 1, durationMs: 1, paceBoundMs: -1 }],
      [{ seq: 1, endWallMs: 1, durationMs: 1, paceBoundMs: 2 }],
      [{ seq: 2, endWallMs: 1, durationMs: 1, paceBoundMs: 0 },
        { seq: 2, endWallMs: 2, durationMs: 1, paceBoundMs: 0 }],
    ]) {
      let error;
      try { paceBoundFraction({ intervals: invalid, window: { startMs: 0, endMs: 2 }, wallOffsetMs: 0 }); } catch (caught) { error = caught; }
      assert(error instanceof RangeError, 'impossible interval values throw RangeError');
    }
  });

  await check('pace bound: conditions without its bar retain the legacy legs', async () => {
    const result = state(0.85, { condition: { bars: { ...BARS, steadyPaceBoundMax: undefined } } });
    assertEqual(result.legs.paceBound, undefined, 'legacy conditions have no pace-bound leg');
    assertEqual(result.steady, true, 'legacy bars still qualify without a pace-bound bar');
  });

  // Mutation proof: a paced host limited by its own bucket is not steady.
  // Opportunity: the held-host fixture above. Action boundary: steadyState(...).reason.
  // Mutation: skipping the pace leg when utilisation.pass turned the named
  // steady-state-pace-bound assertion red; restored, npm run check green again.
  await check('pace bound: the pace leg prevents a paced host from passing', async () => {
    const result = state();
    assertEqual(result.reason, 'steady-state-pace-bound', 'pace-bound action boundary is observed');
    assertEqual(result.steady, false, 'the paced host cannot pass steady state');
  });
}
