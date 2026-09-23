// Queue fields use nearest rank; the name guards the interpolated-median trap (6b design.md D2).

import { computeFigures } from '../../figures/harness-figures.mjs';
import { assert, assertEqual, check } from '../harness.mjs';
import { parseQdisc, parseQdiscJson } from '../../../harness/sample-link.mjs';

const WINDOW = { startMs: 0, endMs: 3_000 };
const CAPACITY = 100_000_000;

function figures(backlogs) {
  return computeFigures({
    window: WINDOW,
    capacityBitsPerSecond: CAPACITY,
    linkSamples: backlogs.map((backlog, index) => ({
      atMs: index * 1_000,
      txBytes: index * 12_500_000,
      qdisc: { backlogBytes: backlog, drops: 0, overlimits: 0 },
    })),
  });
}

export default async function harnessQueueSuite() {
  await check('harness queue: alternating backlog uses nearest-rank p50', async () => {
    const result = figures([0, 2_500_000, 0, 2_500_000]);
    // 2,500,000*8 / 100,000,000*1,000 = 200 ms (6b design.md D2).
    assertEqual(result.capacityBitsPerSecond, CAPACITY, 'capacity is published beside queue fields');
    assertEqual(result.qdiscBacklogNonzeroFraction, 0.5, 'two of four samples have backlog');
    assertEqual(result.qdiscBacklogBytesP99, 2_500_000, 'nearest-rank backlog p99 selects the largest sample');
    assertEqual(result.standingQueueDelayMsP50NearestRank, 0, 'nearest-rank p50 selects the second zero');
    assertEqual(result.standingQueueDelayMsP99, 200, 'nearest-rank queue-delay p99 selects 200 ms');
    assertEqual(result.qdiscBacklogBytesMean, 1_250_000, 'mean backlog remains nonzero');
  });

  await check('harness queue: persistent backlog reports 200 ms at both ranks', async () => {
    const result = figures([2_500_000, 2_500_000, 2_500_000]);
    // 2,500,000*8 / 100,000,000*1,000 = 200 ms (6b design.md D2).
    assertEqual(result.standingQueueDelayMsP50NearestRank, 200, 'persistent queue p50 is 200 ms');
    assertEqual(result.standingQueueDelayMsP99, 200, 'persistent queue p99 is 200 ms');
    assertEqual(result.qdiscBacklogNonzeroFraction, 1, 'all samples hold backlog');
  });

  await check('harness queue: non-finite backlog withholds every new queue field', async () => {
    const result = figures([2_500_000, null, 2_500_000]);
    assertEqual(result.qdiscBacklogNonzeroFraction, undefined, 'non-finite backlog withholds nonzero fraction');
    assertEqual(result.qdiscBacklogBytesP99, undefined, 'non-finite backlog withholds backlog p99');
    assertEqual(result.standingQueueDelayMsP50NearestRank, undefined, 'non-finite backlog withholds queue p50');
    assertEqual(result.standingQueueDelayMsP99, undefined, 'non-finite backlog withholds queue p99');
    assertEqual(result.capacityBitsPerSecond, CAPACITY, 'capacity remains independently available');
  });

  await check('harness queue: negative backlog is physically impossible', async () => {
    let error;
    try {
      figures([0, -1]);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof RangeError, 'negative backlog throws a hard error');
  });

  await check('harness queue: the sampler reads a KiB-multiple backlog that text tc prints as Kb', async () => {
    // 63488 = 62 * 1024, which text tc prints as "backlog 62Kb" (6b design.md D1).
    const text = 'qdisc tbf 10: root refcnt 17 rate 10Mbit burst 4Kb lat 400ms\n Sent 6040622 bytes 4185 pkt (dropped 237, overlimits 12554 requeues 0)\n backlog 62Kb 43p requeues 0\n';
    assertEqual(parseQdisc(text).backlogBytes, null, 'the text parser cannot read Kb');
    const json = JSON.stringify([
      { kind: 'tbf', handle: '10:', root: true, bytes: 6040622, packets: 4185, drops: 237, overlimits: 12554, requeues: 0, backlog: 63488, qlen: 43 },
      { kind: 'netem', handle: '20:', parent: '10:1', bytes: 1, packets: 1, drops: 0, overlimits: 0, requeues: 0, backlog: 0, qlen: 0 },
    ]);
    const root = parseQdiscJson(json);
    assertEqual(root.kind, 'tbf', 'the root entry is read, not the child');
    assertEqual(root.backlogBytes, 63488, 'backlog is exact bytes');
    assertEqual(root.backlogPackets, 43, 'qlen is the packet backlog');
    assertEqual(root.drops, 237, 'drops read');
    assertEqual(parseQdiscJson(JSON.stringify([{ kind: 'tbf', root: true }])).backlogBytes, null, 'absent counter is null, not zero');
  });
}
