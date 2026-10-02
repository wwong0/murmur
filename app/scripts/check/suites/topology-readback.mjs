import { assert, assertEqual, check } from '../harness.mjs';
import { hostSourceOnLoopback, topologyReadback } from '../../harness/topology-readback.mjs';
import { probePathsFromContainers, serviceNames, urlsForDelivery } from '../../harness/topology.mjs';

const address = (name, value) => JSON.stringify([
  { ifname: 'lo', addr_info: [{ family: 'inet', local: '127.0.0.1' }] },
  { ifname: name, addr_info: [{ family: 'inet', local: value }] },
]);

function socket(local, localPort, remote, remotePort) {
  return `ESTAB 0 0 ${local}:${localPort} ${remote}:${remotePort}`;
}

function fixture(overrides = {}) {
  const server = '172.30.0.3';
  const origin = '172.30.0.2';
  const containers = {
    origin: {
      addresses: address('eth-media', origin),
      qdiscs: { 'eth-media': 'qdisc tbf 1: root rate 10mbit' },
      established: socket(origin, 45000, server, 8100),
      listeners: 'LISTEN 0 511 127.0.0.1:8100 0.0.0.0:*\nLISTEN 0 511 127.0.0.1:8102 0.0.0.0:*',
    },
    server: {
      addresses: address('eth-media', server),
      qdiscs: { 'eth-media': 'qdisc fq_codel 0: root' },
      established: [socket(server, 8100, origin, 45000), ...Array.from({ length: 5 }, (_, index) => socket(server, 8100, `172.30.0.${11 + index}`, 40000 + index))].join('\n'),
    },
  };
  for (let index = 0; index < 5; index += 1) {
    containers[`c0${index + 1}`] = {
      addresses: address(`eth-${index}`, `172.30.0.${11 + index}`),
      qdiscs: { [`eth-${index}`]: 'qdisc noqueue 0: root' },
      established: socket(`172.30.0.${11 + index}`, 40000 + index, server, 8100),
    };
  }
  return { containers: { ...containers, ...overrides } };
}

function reasons(raw) {
  return topologyReadback({ raw, declaredViewers: ['c01', 'c02', 'c03', 'c04', 'c05'] }).refusals;
}

export default async function topologyReadbackSuite() {
  await check('topology wiring: host delivery adds server and resolves its three URLs', async () => {
    assert(!serviceNames(2, { delivery: 'http' }).includes('server'), 'http has no server service');
    assert(serviceNames(2, { delivery: 'host' }).includes('server'), 'host has server service');
    assertEqual(urlsForDelivery('host').countersUrl, 'http://127.0.0.1:8111', 'host counters URL');
    assertEqual(urlsForDelivery('host').clientOriginUrl, 'http://server-media:8100', 'host client URL');
    assertEqual(urlsForDelivery('host').hostPageUrl, 'http://127.0.0.1:8100', 'host page URL');
    assertEqual(urlsForDelivery('http').countersUrl, 'http://127.0.0.1:8110', 'http counters URL');
    const hostPaths = probePathsFromContainers({ origin: 'origin', server: 'server', c01: 'client-1' }, { delivery: 'host', clients: 1 });
    assertEqual(hostPaths.c01.server.container, 'server', 'viewer server path');
    assert(!probePathsFromContainers({ origin: 'origin', c01: 'client-1' }, { delivery: 'http', clients: 1 }).c01.server, 'http has no viewer server path');
  });

  await check('topology read-back: five viewers use the server and the host path alone is shaped', async () => {
    const result = topologyReadback({ raw: fixture(), declaredViewers: ['c01', 'c02', 'c03', 'c04', 'c05'] });
    assertEqual(result.origin.mediaAddress, '172.30.0.2', 'origin media address');
    assertEqual(result.server.mediaAddress, '172.30.0.3', 'server media address');
    for (const tag of ['c01', 'c02', 'c03', 'c04', 'c05']) assertEqual(result.viewers[tag].wsPeer, '172.30.0.3', `${tag} peers server`);
    assertEqual(result.refusals.length, 0, 'passing topology has no refusal');
  });

  // Mutation proof: opportunity is a complete five-viewer read-back at the
  // viewer->server action boundary. Dropping the peer/origin comparison turns
  // c03's origin-routed socket into a pass; the red assertion is the named
  // topology-viewer-via-origin check, restored green after checkout.
  await check('topology read-back: a viewer routed through the origin is refused', async () => {
    const raw = fixture();
    raw.containers.c03.established = socket('172.30.0.13', 40002, '172.30.0.2', 8100);
    assert(reasons(raw).includes('topology-viewer-via-origin'), 'topology-viewer-via-origin');
  });

  // Mutation proof: a server qdisc has the opportunity at the topology read
  // boundary. Dropping `tbf` from the discipline set turns this fixture green;
  // the red assertion is topology-server-shaped, restored green after checkout.
  await check('topology read-back: a shaped server is refused', async () => {
    const raw = fixture();
    raw.containers.server.qdiscs['eth-media'] = 'qdisc tbf 1: root rate 10mbit';
    assert(reasons(raw).includes('topology-server-shaped'), 'topology-server-shaped');
  });

  await check('topology read-back: missing and multiply-peered viewers are unreadable', async () => {
    const missing = fixture();
    missing.containers.c04.established = '';
    assert(reasons(missing).includes('topology-viewer-ws-unread'), 'a viewer with no room socket refuses');
    const doubled = fixture();
    doubled.containers.c05.established += `\n${socket('172.30.0.15', 40005, '172.30.0.4', 8100)}`;
    assert(reasons(doubled).includes('topology-viewer-ws-unread'), 'a viewer with two room peers refuses');
  });

  // The server's published port arrives on its control address, and that socket
  // can be listed first. The resolved media addresses decide, not the list order.
  await check('topology read-back: the resolved media addresses outrank the socket order', async () => {
    const raw = fixture();
    raw.containers.server.established = `${socket('172.31.0.3', 8100, '172.31.0.1', 50000)}\n${raw.containers.server.established}`;
    assert(reasons(raw).includes('topology-host-room-unread'), 'the list order alone misreads the server address');
    raw.mediaAddresses = { origin: '172.30.0.2', server: '172.30.0.3' };
    assertEqual(reasons(raw).length, 0, 'resolved addresses read the same topology clean');
    raw.containers.c03.established = socket('172.30.0.13', 40002, '172.30.0.2', 8100);
    assert(reasons(raw).includes('topology-viewer-via-origin'), 'and still refuse a viewer through the origin');
  });

  // Mutation proof: a cross-network host source has the same counter and
  // listener opportunity. Dropping the server-zero term makes this red on the
  // topology loopback assertion; restoring the term returns green.
  await check('topology read-back: host source is loopback only when server bytes stay zero', async () => {
    const readback = topologyReadback({ raw: fixture(), declaredViewers: ['c01'] });
    const passing = hostSourceOnLoopback({
      mediaStart: { counters: { mediaBytesDelivered: 0 } },
      mediaEnd: { counters: { mediaBytesDelivered: 1_000_000 } },
      serverStart: { counters: { mediaBytesDelivered: 0 } },
      serverEnd: { counters: { mediaBytesDelivered: 0 } },
      readback,
    });
    assertEqual(passing.answer, 'loopback', 'loopback source answer');
    const crossed = hostSourceOnLoopback({
      mediaStart: { counters: { mediaBytesDelivered: 0 } },
      mediaEnd: { counters: { mediaBytesDelivered: 1_000_000 } },
      serverStart: { counters: { mediaBytesDelivered: 0 } },
      serverEnd: { counters: { mediaBytesDelivered: 4_096 } },
      readback,
    });
    assertEqual(crossed.answer, 'inconclusive', 'server delivery is not loopback');
    assert(crossed.reason.includes('server-delivered-media'), 'server delivery reason');
  });
}
