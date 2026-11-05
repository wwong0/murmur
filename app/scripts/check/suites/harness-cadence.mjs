// scripts/check/suites/harness-cadence.mjs
//
// The cadence probe's arithmetic and the gate that acts on it.
//
// A headless container has no monitor, so the question this covers is not "is
// the number right" but "can the probe say it has no answer". The classifier
// is handed timestamps directly — no browser, no container — because the three
// outcomes it must tell apart are all producible as arrays.

import { check, assert, assertEqual, assertNear } from '../harness.mjs';
import {
  CEILING_MS,
  DISPERSION_MAX_MS,
  RAF_SAMPLES,
  SIXTY_HZ_INTERVAL_MS,
  assertProbeShape,
  cadenceRecord,
  classifyCadence,
  describeIntervals,
} from '../../harness-cadence.mjs';

/** `count` timestamps at `intervalMs`, with `jitterMs` of deterministic wobble. */
function timestamps(count, intervalMs, jitterMs = 0) {
  return Array.from({ length: count }, (_, index) => index * intervalMs + (jitterMs ? ((index % 2) - 0.5) * jitterMs : 0));
}

function probe({ rafCount = RAF_SAMPLES + 1, rafInterval = SIXTY_HZ_INTERVAL_MS, jitterMs = 0, rvfcCount = 700 } = {}) {
  return {
    rafTimestamps: timestamps(rafCount, rafInterval, jitterMs),
    rvfcDisplayTimes: timestamps(rvfcCount, 1000 / 24),
    rvfcPresentedFrames: rvfcCount,
    hasVideo: true,
    hasRvfc: true,
    elapsedMs: CEILING_MS,
  };
}

export default async function cadenceSuite() {
  await check('harness-cadence: a clustered 60Hz cadence is classified and carries no optimism', async () => {
    const record = cadenceRecord(probe({ jitterMs: 0.2 }), 'c01');
    assertEqual(record.classification, 'synthetic-fixed', 'a round interval is the synthetic source');
    assertNear(record.presentIntervalMs, SIXTY_HZ_INTERVAL_MS, 0.2, 'present interval');
    assertNear(record.impliedHz, 60, 1, 'implied Hz');
    assertEqual(record.optimismVsSixtyHzMs, 0, 'a 60Hz regime flatters nothing');
    assertEqual(record.reasons.length, 0, 'an established cadence carries no reason to refuse');
  });

  await check('harness-cadence: a faster cadence states how optimistic the regime is', async () => {
    const record = cadenceRecord(probe({ rafInterval: 1000 / 180, jitterMs: 0.1 }), 'c01');
    assertEqual(record.classification, 'real-display', '180Hz is not one of the round synthetic rates');
    assertNear(record.optimismVsSixtyHzMs, SIXTY_HZ_INTERVAL_MS - 1000 / 180, 0.15, 'optimism against a 60Hz panel');
    assert(record.optimismVsSixtyHzMs > 10, 'and it is the size D6 warns about, not a rounding');
  });

  await check('harness-cadence: too few callbacks, no video callbacks and dispersion are each "none"', async () => {
    const few = cadenceRecord(probe({ rafCount: RAF_SAMPLES - 1 }), 'c01');
    const noVideo = cadenceRecord({ ...probe(), rvfcDisplayTimes: [], hasRvfc: false }, 'c01');
    const dispersed = cadenceRecord(probe({ jitterMs: 8 }), 'c01');
    for (const record of [few, noVideo, dispersed]) {
      assertEqual(record.classification, 'none', 'cadence is not established');
      assert(record.reasons.length > 0, 'and the record says why');
      assertEqual(record.optimismVsSixtyHzMs, null, 'no optimism figure is derived from a cadence that does not exist');
    }
    assert(few.reasons[0].includes(`${RAF_SAMPLES - 1} rAF`), 'the count is named');
    assert(noVideo.reasons.some((reason) => reason.includes('rVFC')), 'the absent callback is named');
    assert(dispersed.reasons.some((reason) => reason.includes(`${DISPERSION_MAX_MS}ms`)), 'the dispersion bar is named');
  });

  await check('harness-cadence: the dispersion bar discriminates at its own edge', async () => {
    // Alternating the offset by +/- half of `jitterMs` makes every interval
    // either interval+jitter or interval-jitter, so p95-p5 is twice the jitter.
    // These two fixtures differ ONLY in that quantity.
    const inside = describeIntervals(timestamps(RAF_SAMPLES + 1, SIXTY_HZ_INTERVAL_MS, 0.45));
    const outside = describeIntervals(timestamps(RAF_SAMPLES + 1, SIXTY_HZ_INTERVAL_MS, 1.4));
    assert(inside.dispersionMs < DISPERSION_MAX_MS, `${inside.dispersionMs} is inside the bar`);
    assert(outside.dispersionMs >= DISPERSION_MAX_MS, `${outside.dispersionMs} is outside it`);
    const rvfc = describeIntervals(timestamps(700, 1000 / 24));
    assertEqual(classifyCadence({ raf: inside, rvfc }).classification, 'synthetic-fixed', 'inside the bar is a cadence');
    assertEqual(classifyCadence({ raf: outside, rvfc }).classification, 'none', 'outside it is not');
  });

  await check('harness-cadence: the probe shape is asserted before any figure is derived', async () => {
    // An earlier pass derived a whole hardware verdict from a probe that returned a
    // function; `returnByValue` flattened it to {} and every figure printed
    // null.
    for (const bad of [undefined, {}, { rafTimestamps: [] }, { rafTimestamps: [0, Number.NaN], rvfcDisplayTimes: [] }]) {
      let threw = null;
      try {
        assertProbeShape(bad, 'c01');
      } catch (error) {
        threw = error;
      }
      assert(threw !== null, `a probe returning ${JSON.stringify(bad)} is rejected, not derived from`);
      assert(threw.message.includes('c01'), 'and the client is named');
    }
  });
}
