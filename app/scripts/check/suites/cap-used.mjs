import assert from 'node:assert/strict';
import { check } from '../harness.mjs';
import { capUsed } from '../../figures/cap-used.mjs';

const VALUE_TOLERANCE = 1e-9; // Unitless ratio tolerance.

function fixture({ count = 200, handedBytes = 300_000, probeSeq = null } = {}) {
  const first = {
    seq: 1,
    endWallMs: 1_100,
    durationMs: 1_000,
    handedBytes: 2_000_000,
    wireBytes: 2_000_000,
    readingBytesPerSecond: 2_000_000,
    linkBound: true,
    reason: null,
    probe: false,
    headQueueMs: 0,
    tailQueueMs: 0,
    raised: false,
    climbing: true,
  };
  const later = Array.from({ length: count }, (_, index) => {
    const seq = index + 2;
    return {
      seq,
      endWallMs: 100 + 1_000 * seq,
      durationMs: 1_000,
      handedBytes,
      wireBytes: handedBytes,
      readingBytesPerSecond: null,
      linkBound: false,
      reason: 'no-queue',
      probe: seq === probeSeq,
      headQueueMs: 0,
      tailQueueMs: 0,
      raised: false,
      climbing: true,
    };
  });
  return [first, ...later];
}

function assertValue(result, expected, label) {
  assert.ok(Math.abs(result.value - expected) <= VALUE_TOLERANCE, `${label}: ratio tolerance is unitless`);
}

function common(result, handedBytes, allowedBytes) {
  assert.equal(result.handedBytes, handedBytes);
  assert.equal(result.allowedBytes, allowedBytes);
  assert.equal(result.reason, null);
}

export default async function capUsedSuite() {
  await check('cap-used: below the cap', () => {
    const result = capUsed({ intervals: fixture(), window: { startMs: 1_000, endMs: 201_000 }, wallOffsetMs: 100, fraction: 0.5 });
    // 200 overlapping records × 300,000 handed bytes.
    common(result, 60_000_000, 200_000_000);
    // 200 records × (0.5 × 2,000,000 B/s × 1 s).
    assertValue(result, 0.30, 'below cap');
  });

  await check('cap-used: at the cap', () => {
    const result = capUsed({ intervals: fixture({ handedBytes: 970_000 }), window: { startMs: 1_000, endMs: 201_000 }, wallOffsetMs: 100, fraction: 0.5 });
    // 200 overlapping records × 970,000 handed bytes.
    common(result, 194_000_000, 200_000_000);
    assertValue(result, 0.97, 'at cap');
  });

  await check('cap-used: straddle', () => {
    const intervals = fixture({ count: 3, handedBytes: 0 });
    intervals[1].handedBytes = 400_000;
    intervals[2].handedBytes = 800_000;
    intervals[3].handedBytes = 200_000;
    const result = capUsed({ intervals, window: { startMs: 1_500, endMs: 3_500 }, wallOffsetMs: 100, fraction: 0.5 });
    // Half of records 2 and 4 plus all of record 3: 200,000 + 800,000 + 100,000.
    common(result, 1_100_000, 2_000_000);
    assertValue(result, 0.55, 'straddle');
  });

  await check('cap-used: probe interval', () => {
    const intervals = fixture({ count: 3, handedBytes: 1_050_000, probeSeq: 3 });
    const result = capUsed({ intervals, window: { startMs: 1_000, endMs: 3_000 }, wallOffsetMs: 100, fraction: 0.5 });
    // Record 2 uses half the estimate; record 3 uses the 1.1 probe factor.
    assert.equal(result.allowedBytes, 3_200_000);
    assertValue(result, 0.65625, 'probe interval');
  });

  await check('cap-used: not covered', () => {
    const result = capUsed({ intervals: fixture({ count: 150 }), window: { startMs: 1_000, endMs: 201_000 }, wallOffsetMs: 100, fraction: 0.5 });
    assert.equal(result.value, null);
    assert.equal(result.reason, 'pace-evidence-incomplete');
  });

  await check('cap-used: sequence must start at one', () => {
    const intervals = fixture();
    intervals.shift();
    const result = capUsed({ intervals, window: { startMs: 1_000, endMs: 201_000 }, wallOffsetMs: 100, fraction: 0.5 });
    assert.equal(result.value, null);
    assert.equal(result.reason, 'pace-evidence-incomplete');
  });

  await check('cap-used: no pace in force', () => {
    const result = capUsed({ intervals: fixture(), window: { startMs: 0, endMs: 2_000 }, wallOffsetMs: 100, fraction: 0.5 });
    assert.equal(result.value, null);
    assert.equal(result.reason, 'pace-not-in-force');
    assert.equal(result.unpacedMs, 1_000);
  });

  await check('cap-used: replay mismatch', () => {
    const intervals = fixture();
    intervals[1].raised = true;
    const result = capUsed({ intervals, window: { startMs: 1_000, endMs: 201_000 }, wallOffsetMs: 100, fraction: 0.5 });
    assert.equal(result.value, null);
    assert.equal(result.reason, 'pace-replay-mismatch');
  });

  await check('cap-used: final estimate', () => {
    const intervals = fixture();
    const mismatch = capUsed({ intervals, window: { startMs: 1_000, endMs: 201_000 }, wallOffsetMs: 100, fraction: 0.5, finalEstimateBytesPerSecond: 1_999_999 });
    assert.equal(mismatch.value, null);
    assert.equal(mismatch.reason, 'pace-replay-mismatch');
    const match = capUsed({ intervals, window: { startMs: 1_000, endMs: 201_000 }, wallOffsetMs: 100, fraction: 0.5, finalEstimateBytesPerSecond: 2_000_000 });
    // 60,000,000 handed bytes ÷ 200,000,000 allowed bytes.
    assertValue(match, 0.30, 'final estimate');
  });

  await check('cap-used: a record missing a replayed field is missing evidence', () => {
    // The first case with one record's handedBytes absent; nothing else differs.
    const intervals = fixture();
    delete intervals[50].handedBytes;
    const result = capUsed({ intervals, window: { startMs: 1_000, endMs: 201_000 }, wallOffsetMs: 100, fraction: 0.5 });
    assert.equal(result.value, null);
    assert.equal(result.reason, 'pace-evidence-incomplete');
  });

  await check('cap-used: unpaced argument', () => {
    assert.throws(() => capUsed({ intervals: fixture(), window: { startMs: 1_000, endMs: 201_000 }, wallOffsetMs: 100, fraction: 'unpaced' }), RangeError);
  });
}
