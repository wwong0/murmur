import { assert, assertEqual, check } from '../harness.mjs';
import { readyTopology } from '../../harness-run.mjs';

const condition = { delivery: 'host', peerExchange: true, clients: 3 };

function prepared() {
  return {
    containers: { origin: 'origin-container', c01: 'client-1', c02: 'client-2', c03: 'client-3' },
    controlUdpDrop: { readBack: { ingress: 'in', egress: 'out' } },
    mediaDefaultRoute: Object.fromEntries(['origin', 'c01', 'c02', 'c03'].map((tag) => [tag, { readBack: [{ dst: 'default' }] }])),
    probePaths: Object.fromEntries(['origin', 'c01', 'c02', 'c03'].map((tag) => [tag, { container: `${tag}-prepared` }])),
  };
}

function qdisc(tag, rate = 10_000_000, readBack = true) {
  return {
    container: `client-${Number(tag.slice(1))}`,
    containerRole: tag,
    network: 'wa-media', direction: 'egress', discipline: 'tbf',
    ...(readBack ? { readBack: { readings: { rate: { got: rate } } } } : {}),
  };
}

export default async function harnessPeerTopologySuite() {
  await check('T6 4.2: every viewer qdisc read-back publishes shaped at 10,000,000 bit/s', async () => {
    const topology = readyTopology(prepared(), [qdisc('c01'), qdisc('c02'), qdisc('c03')], condition);
    for (const tag of ['c01', 'c02', 'c03']) {
      assertEqual(topology.probePaths[tag].peerLinksShaped, true, `${tag} is published shaped`);
      assertEqual(topology.probePaths[tag].peerLinkRateBitsPerSecond, 10_000_000, `${tag} publishes its read-back rate`);
    }
  });

  await check('T6 4.2: origin-only qdiscs publish every viewer unshaped with null rate', async () => {
    const topology = readyTopology(prepared(), [{ ...qdisc('c01'), container: 'origin-container', containerRole: 'origin' }], condition);
    for (const tag of ['c01', 'c02', 'c03']) {
      assertEqual(topology.probePaths[tag].peerLinksShaped, false, `${tag} origin-only is unshaped`);
      assertEqual(topology.probePaths[tag].peerLinkRateBitsPerSecond, null, `${tag} origin-only rate is null`);
    }
  });

  await check('T6 4.2: a declared viewer qdisc without read-back is unshaped with null rate', async () => {
    const topology = readyTopology(prepared(), [qdisc('c01', 10_000_000, false), qdisc('c02'), qdisc('c03')], condition);
    assertEqual(topology.probePaths.c01.peerLinksShaped, false, 'c01 missing read-back is unshaped');
    assertEqual(topology.probePaths.c01.peerLinkRateBitsPerSecond, null, 'c01 missing read-back rate is null');
    assert(topology.probePaths.c02.peerLinksShaped && topology.probePaths.c03.peerLinksShaped, 'other viewers retain their read-backs');
  });
}
