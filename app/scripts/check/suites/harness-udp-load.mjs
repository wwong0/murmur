import { parseArgs, udpPacingTick } from '../../../harness/background-load.mjs';
import { BARS, evaluateArm } from '../../harness-verify-impairment.mjs';
import { assert, assertEqual, check } from '../harness.mjs';

function capacityReading(mbps = 100) {
  return {
    sender: { startedAtMs: 0, endedAtMs: 10_000 },
    start: { atMs: 0, udpBytes: 0 },
    end: { atMs: 10_000, udpBytes: mbps * 10_000 * 1_000 / 8 },
    udpBytesDelta: mbps * 10_000 * 1_000 / 8,
    elapsedMs: 10_000,
    mbps,
  };
}

function lossReading(originLoss = 0.05, clientLoss = 0.05) {
  return {
    lossOriginToClient: { received: { lossFraction: originLoss } },
    lossClientToOrigin: { received: { lossFraction: clientLoss } },
    originImpairment: { root: { handle: '10:', parent: 'root' }, child: { handle: '20:', parent: '10:1' }, childLimit: 1000 },
    udpCapacity: capacityReading(),
  };
}

export default async function harnessUdpLoadSuite() {
  await check('harness udp load: protocol defaults to tcp', async () => {
    assertEqual(parseArgs(['--to=sink:9500', '--mbps=90']).protocol, 'tcp', 'absent protocol selects the unchanged TCP path');
    assertEqual(parseArgs(['--to=sink:9500', '--mbps=90', '--protocol=udp']).protocol, 'udp', 'UDP protocol is accepted');
    let error;
    try {
      parseArgs(['--to=sink:9500', '--mbps=90', '--protocol=sctp']);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof Error, 'an unknown protocol throws');
  });

  await check('harness udp load: paced datagrams carry the byte remainder', async () => {
    let remainderBytes = 0;
    let datagrams = 0;
    for (let tick = 0; tick < 100; tick++) {
      const pacing = udpPacingTick({ mbps: 90, granularityMs: 10, remainderBytes });
      if (tick === 0) assertEqual(pacing.bytesPerTick, 112_500, '90 Mbps over 10 ms is 112,500 bytes');
      remainderBytes = pacing.remainderBytes;
      datagrams += pacing.datagrams;
    }
    // floor(100 * 112,500 / 1,400) = 8,035; carried remainder avoids UDP underfill.
    assert(Math.abs(datagrams - Math.floor(11_250_000 / 1_400)) <= 1, '100 ticks preserve the paced datagram total');
  });

  await check('harness udp load: cap100 is two-sided', async () => {
    const below = evaluateArm('cap100', { goodput: { mbps: 84.9 } });
    const atLow = evaluateArm('cap100', { goodput: { mbps: BARS.cap100GoodputMbps[0] } });
    const atHigh = evaluateArm('cap100', { goodput: { mbps: BARS.cap100GoodputMbps[1] } });
    const above = evaluateArm('cap100', { goodput: { mbps: 105.1 } });
    assert(!below.ok, '84.9 Mbps is below the cap100 interval');
    assert(atLow.ok && atHigh.ok, 'both cap100 endpoints pass');
    assert(!above.ok, '105.1 Mbps is above the cap100 interval');
  });

  await check('harness udp load: loss5-cap100 rejects out-of-bar loss', async () => {
    const low = evaluateArm('loss5-cap100', lossReading(0.029, 0.05));
    const high = evaluateArm('loss5-cap100', lossReading(0.05, 0.071));
    const pass = evaluateArm('loss5-cap100', lossReading());
    assert(!low.ok && !low.assertions[0].ok, '2.9% origin-to-client loss fails');
    assert(!high.ok && !high.assertions[1].ok, '7.1% client-to-origin loss fails');
    assert(pass.ok, 'constructed 5% losses and 100 Mbps capacity pass');
  });
}
