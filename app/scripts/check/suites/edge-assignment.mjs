import { assert, assertEqual, check } from '../harness.mjs';
import { edgeRank, viewerOrder } from '../../../public/lib/edge-assignment.mjs';

export default async function edgeAssignmentSuite() {
  await check('edge-assignment: viewer order excludes the host and is roster-independent', async () => {
    const firstRoster = [
      { clientId: 'viewer-z', role: 'viewer' },
      { clientId: 'host', role: 'host' },
      { clientId: 'viewer-A', role: 'viewer' },
      { clientId: 'viewer-a', role: 'viewer' },
    ];
    const secondRoster = [firstRoster[2], firstRoster[0], firstRoster[3], firstRoster[1]];
    const first = viewerOrder(firstRoster);
    const second = viewerOrder(secondRoster);
    assertEqual(first.join(','), 'viewer-A,viewer-a,viewer-z', 'viewer order uses code-unit sorting');
    assertEqual(second.join(','), first.join(','), 'viewer order ignores roster order');
    // The host had an opportunity to enter the assignment; the boundary is the
    // published viewer list. Mutation: include every roster member. Named red:
    // `viewer order uses code-unit sorting`. Restored with git checkout -- and
    // rerun green; the paired roster still agrees on every viewer.
  });

  await check('edge-assignment: rotation covers every viewer at every segment', async () => {
    const viewerIds = ['a', 'b', 'c', 'd', 'e'];
    const table = Array.from({ length: 10 }, (_unused, segmentIndex) => (
      viewerIds.map((selfId) => edgeRank({ viewerIds, selfId, segmentIndex }))
    ));
    const rankZeroCounts = viewerIds.map((selfId, index) => table.flatMap((row, segmentIndex) => (
      row[index] === 0 ? [segmentIndex] : []
    )).length);
    const ranksPerSegment = table.map((row) => [...row].sort((left, right) => left - right));
    assertEqual(rankZeroCounts.join(','), '2,2,2,2,2', 'each viewer is rank 0 exactly twice');
    assertEqual(ranksPerSegment.every((row) => row.join(',') === '0,1,2,3,4'), true, 'each segment has ranks 0 through 4');
    // Opportunity is ten segment indexes and the boundary is the complete rank
    // table. Mutation: edgeRank ignores segmentIndex. Named red: `each viewer is
    // rank 0 exactly twice`. Restoration with git checkout -- made this assertion
    // green again before completion.
  });

  await check('edge-assignment: missing and malformed inputs use the fallback ranks', async () => {
    const viewerIds = ['a', 'b', 'c'];
    assertEqual(edgeRank({ viewerIds, selfId: 'missing', segmentIndex: 2 }), 3, 'unlisted viewer ranks after the roster');
    assertEqual(edgeRank({ viewerIds: [], selfId: 'a', segmentIndex: 2 }), 0, 'empty roster starts immediately');
    const zero = edgeRank({ viewerIds, selfId: 'b', segmentIndex: 0 });
    const malformed = [-1, 1.5, Number.NaN].map((segmentIndex) => (
      edgeRank({ viewerIds, selfId: 'b', segmentIndex })
    ));
    assertEqual(malformed.every((rank) => rank === zero), true, 'invalid segment indexes use zero');
  });
}
