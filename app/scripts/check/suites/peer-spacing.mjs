import { peerSpacing } from '../../figures/peer-spacing.mjs';
import { PEER_ATTEMPT_COHORT_METHOD } from '../../figures/peer-figures.mjs';
import { missingFields, REQUIRED_CONTEXT_FIELDS } from '../../figures/publication.mjs';
import { assertEqual, check } from '../harness.mjs';

const WINDOW = { startMs: 100_000, endMs: 160_000 };
const TAGS = ['c01', 'c02', 'c03'];
const OFFSETS = { c01: 0, c02: 30_000, c03: 60_000 };

const start = (playAtSharedMs, latenessMs) => ({ playAtSharedMs, latenessMs });

function clients(latenesses) {
  return Object.fromEntries(TAGS.map((tag, index) => [tag, { starts: [start(50_000 + index, latenesses[index])] }]));
}

// Every peer byte field present, so the only missing one is what a case removes.
function publishableFigure(spacing) {
  const figure = { byteAccountingMethod: PEER_ATTEMPT_COHORT_METHOD };
  for (const field of REQUIRED_CONTEXT_FIELDS.peerByte) {
    const keys = field.split('.');
    let node = figure;
    for (const key of keys.slice(0, -1)) node = node[key] ??= {};
    const leaf = keys.at(-1);
    node[leaf] ??= leaf.endsWith('ByClient') ? Object.fromEntries(TAGS.map((tag) => [tag, 1])) : 1;
  }
  return { ...figure, ...spacing };
}

export default async function peerSpacingSuite() {
  await check('peer spacing: declared offset minus the lateness of the start in force', async () => {
    const spacing = peerSpacing({ clients: clients([5_000, 29_600, 6_000]), tags: TAGS,
      condition: { positionOffsetMsByClient: OFFSETS }, window: WINDOW });
    assertEqual(JSON.stringify(spacing.declaredOffsetMsByClient), JSON.stringify(OFFSETS), 'declared offsets');
    assertEqual(JSON.stringify(spacing.startLatenessMsByClient), JSON.stringify({ c01: 5_000, c02: 29_600, c03: 6_000 }), 'latenesses');
    assertEqual(JSON.stringify(spacing.achievedSpacingMsByClient), JSON.stringify({ c01: -5_000, c02: 400, c03: 54_000 }), '0 − 5000, 30000 − 29600, 60000 − 6000');
  });

  await check('peer spacing: a condition with no offsets declares zero', async () => {
    const spacing = peerSpacing({ clients: clients([5_000, 29_600, 6_000]), tags: TAGS, condition: {}, window: WINDOW });
    assertEqual(spacing.declaredOffsetMsByClient.c02, 0, 'no declared offset is zero');
    assertEqual(spacing.achievedSpacingMsByClient.c02, -29_600, 'zero minus the lateness');
  });

  await check('peer spacing: the start in force is the last one before the window, and none is null', async () => {
    const twoStarts = { c01: { starts: [start(90_000, 1_000), start(WINDOW.startMs + 1, 7_000)] } };
    const chosen = peerSpacing({ clients: twoStarts, tags: ['c01'], condition: {}, window: WINDOW });
    assertEqual(chosen.startLatenessMsByClient.c01, 1_000, 'a start after the window opens is not in force');
    const onBoundary = { c01: { starts: [start(90_000, 1_000), start(WINDOW.startMs, 7_000)] } };
    assertEqual(peerSpacing({ clients: onBoundary, tags: ['c01'], condition: {}, window: WINDOW }).startLatenessMsByClient.c01,
      7_000, 'a start playing exactly at the window start is in force');
    const late = { c01: { starts: [start(WINDOW.startMs + 1, 7_000)] } };
    const none = peerSpacing({ clients: late, tags: ['c01'], condition: {}, window: WINDOW });
    assertEqual(none.startLatenessMsByClient.c01, null, 'no start in force is null, not zero');
    assertEqual(none.achievedSpacingMsByClient.c01, null, 'and so is its spacing');
  });

  await check('peer spacing: a null spacing withholds the peer byte figure by name', async () => {
    const context = { byteAccountingMethod: PEER_ATTEMPT_COHORT_METHOD, declaredClientTags: TAGS };
    const complete = peerSpacing({ clients: clients([5_000, 29_600, 6_000]), tags: TAGS,
      condition: { positionOffsetMsByClient: OFFSETS }, window: WINDOW });
    assertEqual(missingFields('byte', context, publishableFigure(complete)), null, 'complete spacing publishes');
    const withNull = structuredClone(complete);
    withNull.startLatenessMsByClient.c02 = null;
    withNull.achievedSpacingMsByClient.c02 = null;
    assertEqual(missingFields('byte', context, publishableFigure(withNull)), 'startLatenessMsByClient[c02]', 'the missing viewer is named');
  });
}
