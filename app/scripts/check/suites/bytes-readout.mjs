import { check, assert, assertEqual } from '../harness.mjs';
import {
  BYTES_LINE_HOST,
  BYTES_LINE_NOTHING_KEPT_RE,
  BYTES_LINE_OFF,
  BYTES_LINE_RE,
  BYTES_LINE_UNAVAILABLE,
  bytesText,
} from '../../../public/lib/bytes-readout.mjs';

const off = { attribution: null, peerExchange: 'off', peerId: null, peerIds: [] };
const host = { attribution: null, peerExchange: 'host', peerId: null, peerIds: [] };
const trackedStub = { attribution: null, peerExchange: 'on', peerId: null, peerIds: [] };
const unavailable = { attribution: 'unavailable', peerExchange: 'on', peerId: null, peerIds: [] };
const active = {
  attribution: 'engine-request',
  peerExchange: 'on',
  peerId: 'self',
  peerIds: ['self'],
  kept: { hostBytes: 7, peerBytes: 4 },
  uploadBytes: { alpha: 8, beta: 11 },
  connected: ['alpha', 'beta'],
  records: [{ kind: 'attempt', bytes: 999 }],
};

export default async function bytesReadoutSuite() {
  await check('bytes readout: every form has exactly one published shape', async () => {
    const cases = [
      ['off', off],
      ['host', host],
      ['tracked stub', trackedStub],
      ['unavailable', unavailable],
      ['active', active],
    ];
    const lines = cases.map(([name, reading]) => ({ name, line: bytesText(reading) }));

    for (const { name, line } of lines) {
      const isActive = name === 'active';
      const isNothing = name === 'tracked stub';
      assertEqual(BYTES_LINE_RE.test(line), isActive, `${name} has only the active shape`);
      assertEqual(BYTES_LINE_NOTHING_KEPT_RE.test(line), isNothing, `${name} has only the nothing-kept shape`);
      if (name === 'off') assertEqual(line, BYTES_LINE_OFF, 'off keeps its named form');
      if (name === 'host') assertEqual(line, BYTES_LINE_HOST, 'host keeps its named form');
      if (name === 'unavailable') assertEqual(line, BYTES_LINE_UNAVAILABLE, 'unavailable keeps its named form');
    }
  });

  await check('bytes readout: the tracked stub is nothing kept, not unavailable', async () => {
    assertEqual(bytesText(trackedStub), 'bytes: nothing kept yet · uploaded 0 B · 0 peers connected', 'the pre-engine on stub names zero kept bytes');
    assert(bytesText(trackedStub) !== BYTES_LINE_UNAVAILABLE, 'the pre-engine on stub is not unavailable');
  });

  await check('bytes readout: active captures published bytes and hand-computed fraction', async () => {
    const line = bytesText(active);
    const match = BYTES_LINE_RE.exec(line);
    assert(match !== null, `the active line matches its shape: ${line}`);
    assertEqual(JSON.stringify(match.slice(1)), JSON.stringify(['7', '4', '19', '0.3636', '2']), 'captures equal the reading and hand-computed fraction');
  });

  await check('bytes readout: off is named, not zeroed', async () => {
    assertEqual(bytesText(off), BYTES_LINE_OFF, 'peer exchange off is a named state');
  });
}
