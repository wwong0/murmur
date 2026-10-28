import { computeOneViewing } from '../../figures/one-viewing.mjs';
import { computePeerFigures } from '../../figures/peer-figures.mjs';
import { assert, assertEqual, check } from '../harness.mjs';

const tags = ['c01', 'c02', 'c03', 'c04', 'c05'];
const record = (time, media = time) => ({ displaySharedMs: time, scheduledMediaMs: time, mediaMs: media });
function fixture() {
  return {
    tags, clients: Object.fromEntries(tags.map((tag) => [tag, { records: [record(0), record(100_400)] }])),
    window: { startMs: 0, endMs: 100_400 }, segmentSizes: [200_000], segmentSeconds: 200,
  };
}

export default async function oneViewingBoundariesSuite() {
  await check('one viewing boundaries: a complete single-viewer room remains valid', async () => {
    const input = fixture();
    input.tags = ['c01'];
    const result = computeOneViewing(input);
    assertEqual(result.oneViewingBytesInWindow, 100_400, 'one complete viewer computes the original bytes');
    assertEqual(result.roomStretchMs.start, 0, 'single viewer start');
    assertEqual(result.roomStretchMs.end, 100_400, 'single viewer end');
    assertEqual(result.oneViewingExcludedByBoundary, undefined, 'no viewer is excluded');
  });
  await check('one viewing boundaries: complete records preserve the previous object', async () => {
    const input = fixture();
    const actual = computeOneViewing(input);
    const positions = Object.fromEntries(tags.map((tag) => [tag, 0]));
    const ends = Object.fromEntries(tags.map((tag) => [tag, 100_400]));
    const played = Object.fromEntries(tags.map((tag) => [tag, { start: 0, end: 100_400 }]));
    assertEqual(JSON.stringify(actual), JSON.stringify({ roomStretchMs: { start: 0, end: 100_400 },
      roomPositionSpreadMs: { start: 0, end: 0 }, roomPositionMsByClient: { start: positions, end: ends },
      playedMediaMsByClient: played, oneViewingBytesInWindow: 100_400 }), 'complete shape and values stay equal');
  });
  await check('one viewing boundaries: held end and excluded late start', async () => {
    const input = fixture();
    input.clients.c03.records = [record(0), record(100_000)];
    let result = computeOneViewing(input);
    assertEqual(result.oneViewingBytesInWindow, 100_400, 'room bytes computed');
    assertEqual(result.playedMediaMsByClient.c03.end, 100_000, 'last media held');
    assertEqual(result.oneViewingHeldByClient.c03.end, 'held-last', 'held end listed');
    const peer = { ...input, declaredClientTags: tags, multiplierDenominator: 'one-viewing',
      content: { segmentSizes: input.segmentSizes }, condition: { bars: {} },
      originStart: { mediaBytesDelivered: 0 }, originEnd: { mediaBytesDelivered: 0 } };
    const pairing = { byClient: Object.fromEntries(tags.map((tag) => [tag, { pairs: [] }])), excused: [] };
    const figures = computePeerFigures(peer, pairing);
    assertEqual(figures.oneViewingHeldByClient.c03.end, 'held-last', 'peer figures publish held end');
    assert(figures.hostUploadMultiplierRefusal?.reason !== 'one-viewing-unavailable', 'held end does not refuse one viewing');
    input.clients.c05.records = [record(5000), record(100_400)];
    result = computeOneViewing(input);
    assertEqual(result.roomStretchMs.start, 0, 'other four set start median');
    assertEqual(result.oneViewingExcludedByBoundary.start.join(','), 'c05', 'late viewer excluded');
    assertEqual(result.playedMediaMsByClient.c05.start, 5000, 'first media held');
    assertEqual(result.oneViewingHeldByClient.c05.start, 'held-first', 'held start listed');
  });
  await check('one viewing boundaries: insufficient viewers and reversed stretch refuse', async () => {
    const input = fixture();
    for (const tag of tags.slice(1)) input.clients[tag].records = [record(5000), record(100_400)];
    let error;
    try { computeOneViewing(input); } catch (caught) { error = caught; }
    assert(error?.message.startsWith('drift-record-before-boundary-unavailable:c02:'), 'one viewer is insufficient');
    const base = fixture();
    base.clients.c03.records = [record(0, 100), record(100_000, 50)];
    const peer = { ...base, declaredClientTags: tags, multiplierDenominator: 'one-viewing',
      content: { segmentSizes: base.segmentSizes }, condition: { bars: {} },
      originStart: { mediaBytesDelivered: 0 }, originEnd: { mediaBytesDelivered: 0 } };
    const pairing = { byClient: Object.fromEntries(tags.map((tag) => [tag, { pairs: [] }])), excused: [] };
    const result = computePeerFigures(peer, pairing);
    assertEqual(result.hostUploadMultiplierRefusal?.reason, 'one-viewing-unavailable', 'invalid stretch refuses');
    assertEqual(result.hostUploadMultiplierRefusal?.detail, 'played-stretch-invalid:c03', 'invalid viewer named');
  });
}
