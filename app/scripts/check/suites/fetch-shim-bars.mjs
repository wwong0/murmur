import { assert, assertEqual, check } from '../harness.mjs';
import { FETCH_SHIM_BARS, evaluateFetchShim, mutateFetchObservation } from '../../figures/fetch-shim-bars.mjs';

const LENGTH = 1_000_000;
const EXPECTED = Object.freeze({
  length: LENGTH,
  openRange: Object.freeze({ start: 100_000, end: LENGTH - 1, length: LENGTH - 100_000 }),
});

function completeCase({ status = 200, contentLength = LENGTH, contentRange = null, bodyBytes = LENGTH, chunkCount = 1 } = {}) {
  return {
    status,
    headers: { contentLength: String(contentLength), contentRange },
    bodyBytes,
    chunkCount,
    hashMatches: true,
    settlement: { kind: 'complete', errorName: null },
    receipt: { finished: true, canceled: false, bodyBytes },
    pendingCleared: true,
    requestsUnchanged: true,
  };
}

const BASELINE = {
  a: completeCase(),
  b: completeCase({ status: 206, contentLength: EXPECTED.openRange.length, contentRange: { from: EXPECTED.openRange.start, to: EXPECTED.openRange.end, total: LENGTH }, bodyBytes: EXPECTED.openRange.length }),
  c: completeCase({ status: 206, contentLength: 100, contentRange: { from: 100, to: 199, total: LENGTH }, bodyBytes: 100 }),
  d: completeCase({ chunkCount: 3 }),
  e: {
    ...completeCase({}),
    bodyBytes: 64_000,
    chunkCount: 1,
    settlement: { kind: 'abort-read-rejected', errorName: 'AbortError' },
    receipt: { finished: false, canceled: true, bodyBytes: 64_000 },
  },
  f: {
    ...completeCase({}),
    bodyBytes: 64_000,
    chunkCount: 1,
    settlement: { kind: 'cancel-resolved', errorName: null },
    receipt: { finished: false, canceled: true, bodyBytes: 64_000 },
  },
  g: {
    status: null,
    headers: { contentLength: null, contentRange: null },
    bodyBytes: 0,
    chunkCount: 0,
    hashMatches: false,
    settlement: { kind: 'fetch-rejected', errorName: 'AbortError' },
    receipt: null,
    pendingCleared: true,
    requestsUnchanged: true,
  },
};

export default async function fetchShimBarsSuite() {
  await check('fetch-shim bars: one complete observation set passes every bar', async () => {
    const result = evaluateFetchShim(BASELINE, EXPECTED);
    assertEqual(result.pass, true, 'the complete observation set passes');
    assertEqual(result.bars.length, FETCH_SHIM_BARS.length, 'every declared bar is evaluated');
    assert(result.bars.every((bar) => bar.pass), 'every browser contract bar passes');
    for (const caseKey of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) assertEqual(result.byCase[caseKey].pass, true, `${caseKey} passes`);
  });

  for (const bar of FETCH_SHIM_BARS) {
    await check(`fetch-shim bars: ${bar.key} fails on its named field only`, async () => {
      const mutated = mutateFetchObservation(BASELINE, bar.key, EXPECTED);
      const result = evaluateFetchShim(mutated, EXPECTED);
      const failed = result.bars.filter((candidate) => !candidate.pass).map((candidate) => candidate.key);
      assertEqual(JSON.stringify(failed), JSON.stringify([bar.key]), `${bar.key} is the only failed bar`);
    });
  }
}

