import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { conditionWithRules } from '../../harness-figures.mjs';
import { steadyState } from '../../figures/peer-figures.mjs';
import { recoverySpans, sweepFigures } from '../../figures/control-figures.mjs';

const TOLERANCE = 1e-9; // Unitless ratio tolerance.
const BASE_BARS = {
  steadyUtilisationMax: 0.90,
  steadyDownloadRatioMin: 0.95,
  steadyDownloadRatioMax: 1.25,
  steadyRealtimeMin: 0.98,
};

function intervals({ laterCount = 200, handedBytes = 300_000, paceBoundMs = 180, handedFor } = {}) {
  const first = {
    seq: 1, endWallMs: 1_100, durationMs: 1_000, paceBoundMs,
    handedBytes: 2_000_000, wireBytes: 2_000_000, readingBytesPerSecond: 2_000_000,
    linkBound: true, reason: null, probe: false, headQueueMs: 0, tailQueueMs: 0,
    raised: false, climbing: true,
  };
  const later = Array.from({ length: laterCount }, (_, index) => {
    const seq = index + 2;
    const handed = handedFor ? handedFor(seq) : handedBytes;
    return {
      seq, endWallMs: 100 + 1_000 * seq, durationMs: 1_000, paceBoundMs,
      handedBytes: handed, wireBytes: handed, readingBytesPerSecond: null,
      linkBound: false, reason: 'no-queue', probe: false, headQueueMs: 0, tailQueueMs: 0,
      raised: false, climbing: true,
    };
  });
  return [first, ...later];
}

function steadyFixture({ capBar = 0.90, paceBar = null, fraction = 0.5, handedBytes = 300_000,
  laterCount = 200, paceBoundMs = 180, uplink = 0.84 } = {}) {
  const bars = { ...BASE_BARS, steadyCapUsedMax: capBar, steadyPaceBoundMax: paceBar };
  const input = {
    condition: { peerExchange: true, bars },
    declaredClientTags: ['c01'],
    clients: { c01: { records: [], polls: [] } },
    headroom: { fraction },
    hostPace: { intervals: intervals({ laterCount, handedBytes, paceBoundMs }), fraction },
    hostPaceFinal: { estimate: { bytesPerSecond: 2_000_000 }, fraction },
    wallOffsetMs: 100,
    window: { startMs: 1_000, endMs: 201_000 },
    content: { segmentSizes: [1_000] },
    segmentSeconds: 1,
  };
  return {
    input,
    tags: ['c01'],
    figures: { uplinkUtilisationMean: uplink, realtimeFactorByClient: { c01: 1 } },
    cohorts: { c01: [{ path: '/media/seg-00000.m4s', lengthBytes: 1_000 }] },
    oneViewing: { playedMediaMsByClient: { c01: { start: 0, end: 1_000 } } },
  };
}

function state(options = {}) {
  const fixture = steadyFixture(options);
  return steadyState({ ...fixture, hostPace: fixture.input.hostPace, wallOffsetMs: fixture.input.wallOffsetMs });
}

function recoveryFixture() {
  const hostPace = { intervals: intervals({
    handedFor: (seq) => (seq <= 120 ? 300_000 : 970_000),
  }), fraction: 0.5 };
  return {
    condition: { peerExchange: true, bars: { ...BASE_BARS, steadyCapUsedMax: 0.90 } },
    declaredClientTags: [], clients: {}, viewerPolls: {},
    headroom: { fraction: 0.5 }, hostPace,
    hostPaceFinal: { estimate: { bytesPerSecond: 2_000_000 } },
    wallOffsetMs: 100, window: { startMs: 0, endMs: 180_000 },
    linkSamples: [
      { atMs: 0, txBytes: 0 }, { atMs: 60_000, txBytes: 63_000_000 },
      { atMs: 120_000, txBytes: 126_000_000 }, { atMs: 180_000, txBytes: 189_000_000 },
    ],
    capacityBitsPerSecond: 10_000_000,
    content: { segmentSizes: [] },
  };
}

export default async function steadyCapUsedSuite() {
  await check('steady cap-used: below the cap passes and pace is published', async () => {
    const result = state();
    // 60,000,000 / 200,000,000 = 0.30; 180ms / 1000ms = 0.18.
    assertNear(result.legs.capUsed.value, 0.30, TOLERANCE, 'cap value is 0.30');
    assertEqual(result.reason, null, 'no steady leg fails below cap');
    assertEqual(result.steady, true, 'below-cap host is steady');
    assertEqual(result.legs.capUsed.pass, true, '0.30 is below the 0.90 cap bar');
    assertEqual(result.legs.paceBound, undefined, 'cap leg replaces pace-bound leg');
    assertNear(result.pace.paceBound.value, 0.18, TOLERANCE, 'pace-bound value is published');
  });

  await check('steady cap-used: whole-cap usage refuses the multiplier', async () => {
    const result = state({ handedBytes: 970_000 });
    // 194,000,000 / 200,000,000 = 0.97, above the declared 0.90 bar.
    assertEqual(result.steady, false, 'whole-cap host is not steady');
    assertEqual(result.reason, 'steady-state-cap-used', 'cap refusal is named');
    assertNear(result.legs.capUsed.value, 0.97, TOLERANCE, 'cap value is 0.97');
  });

  await check('steady cap-used: pace-bound remains the selected leg', async () => {
    const result = state({ capBar: null, paceBar: 0.10, handedBytes: 840_000, paceBoundMs: 250 });
    // 250ms / 1000ms = 0.25, while the cap replay remains available at 0.84.
    assertEqual(result.steady, false, 'pace-bound host is not steady');
    assertEqual(result.reason, 'steady-state-pace-bound', 'pace-bound refusal is retained');
    assertNear(result.legs.paceBound.value, 0.25, TOLERANCE, 'pace-bound value is 0.25');
    assertEqual(result.pace.tested, 'paceBound', 'pace-bound is the tested declaration');
    assertNear(result.pace.capUsed.value, 0.84, TOLERANCE, 'cap value remains published');
  });

  await check('steady cap-used: missing evidence cannot pass', async () => {
    const result = state({ laterCount: 170 });
    assertEqual(result.steady, false, 'incomplete cap evidence is not steady');
    assertEqual(result.legs.capUsed.pass, false, 'incomplete cap leg does not pass');
    assertEqual(result.legs.capUsed.value, null, 'incomplete cap value is null');
    assertEqual(result.legs.capUsed.reason, 'pace-evidence-incomplete', 'incomplete evidence is named');
  });

  await check('steady cap-used: unpaced hosts use utilisation alone', async () => {
    const passing = state({ fraction: 'unpaced', uplink: 0.50 });
    const failing = state({ fraction: 'unpaced', uplink: 0.95 });
    assertEqual(passing.legs.capUsed.applies, false, 'unpaced cap leg is not applied');
    assertEqual(passing.steady, true, 'unpaced utilisation below bar passes');
    assertEqual(failing.reason, 'steady-state-utilisation', 'utilisation still decides unpaced host');
  });

  await check('steady cap-used: the declaration supplies the bar', async () => {
    const highBar = state({ handedBytes: 970_000, capBar: 0.98 });
    const lowBar = state({ capBar: 0.25 });
    // The same replay value is compared with 0.98 in the first case and 0.25 in the second.
    assertNear(highBar.legs.capUsed.value, 0.97, TOLERANCE, 'bar fixture value is 0.97');
    assertEqual(highBar.reason, null, 'no steady leg fails with the 0.98 bar');
    assertEqual(highBar.steady, true, '0.97 passes the declared 0.98 bar');
    assertEqual(lowBar.steady, false, '0.30 fails the declared 0.25 bar');
  });

  await check('steady cap-used: both pace bars are forbidden', async () => {
    let error;
    try { state({ paceBar: 0.10 }); } catch (caught) { error = caught; }
    assertEqual(error?.message, 'steady-pace-bars-conflict', 'both pace bars have one conflict error');
  });

  await check('steady cap-used: recovery spans select and report cap leg', async () => {
    const input = recoveryFixture();
    const result = recoverySpans({ input, transition: 0, recordingEnd: 180_000, spanMs: 60_000,
      hostPace: input.hostPace, wallOffsetMs: input.wallOffsetMs });
    // The first span overlaps the seed before its estimate, then 0.30 and 0.97 occupy later spans.
    assertEqual(result.spans[0].incomplete, true, 'the first span is incomplete without pace in force');
    assertEqual(result.spans[0].legs.capUsed.reason, 'pace-not-in-force', 'missing pace is named');
    assertNear(result.spans[1].legs.capUsed.value, 0.30, TOLERANCE, 'recovery cap value is 0.30');
    assertEqual(result.spans[1].legs.utilisation.pass, true, 'recovery utilisation passes');
    assertEqual(result.spans[1].pass, true, 'the 0.30 span passes');
    assertEqual(result.spans[2].pass, false, 'the 0.97 span fails');
    assertEqual(result.spans[2].failedLegs.join(','), 'capUsed', 'only capUsed fails in the 0.97 span');
    assertEqual(result.spans[2].incomplete, false, 'the 0.97 span is complete evidence');
    const sweep = sweepFigures({ input: { ...input, timebase: { offsetMs: 0, wallOffsetMs: 100 } }, spans: result.spans });
    assertNear(sweep[1].capUsed.value, 0.30, TOLERANCE, 'sweep publishes capUsed beside paceBound');
  });

  await check('steady cap-used: rule overrides copy the condition', async () => {
    const condition = { delivery: 'host', bars: { keep: 0.90, remove: 0.80 }, excusals: { old: true } };
    const before = JSON.stringify(condition);
    const copy = conditionWithRules(condition, { bars: { add: 0.25 }, removeBars: ['remove'], excusals: { fresh: true } });
    assertEqual(copy.bars.keep, 0.90, 'unchanged bar remains');
    assertEqual('remove' in copy.bars, false, 'removed bar is absent');
    assertEqual(copy.bars.add, 0.25, 'added bar is present');
    assertEqual(JSON.stringify(copy.excusals), '{"fresh":true}', 'rule excusals replace the input');
    assertEqual(JSON.stringify(condition), before, 'the input condition is unmodified');
    assertEqual(conditionWithRules(condition, undefined), condition, 'absent rules leave the registered condition');
    for (const rules of [{ bars: { bad: 'x' } }, { removeBars: 'remove' }, { removeBars: [1] }]) {
      let error;
      try { conditionWithRules(condition, rules); } catch (caught) { error = caught; }
      assert(error instanceof TypeError, `malformed rules throw TypeError: ${JSON.stringify(rules)}`);
    }
  });
}
