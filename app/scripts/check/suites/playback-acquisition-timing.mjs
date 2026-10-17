import {
  assert,
  check,
  Peer,
  rosterOfRoom,
  waitEvent,
} from '../harness.mjs';
import { FROZEN_WS } from '../fixtures.mjs';
import { TYPE_PLAYBACK_STATE_REQUEST } from '../../../public/lib/envelope.mjs';
import { createPlaybackAcquisition } from '../../../public/lib/playback-acquisition.mjs';
import { median } from '../../lead-measurement.mjs';

const clock = { sharedNow: () => performance.timeOrigin + performance.now() };

function waitFor(test, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (test()) resolve();
      else if (Date.now() >= deadline) reject(new Error(`timed out waiting for ${label}`));
      else setTimeout(poll, 5);
    };
    poll();
  });
}

async function measure({ room, peer, client }, requestTimeoutMs, backoffMs, label) {
  const silent = await peer(`${label}-silent`, FROZEN_WS);
  const joined = await silent.join({ room, tabId: `${label}-silent`, role: 'viewer' });
  assert(joined.type === 'joined', `${label}: silent member joined`);
  const receivedAt = [];
  silent.ws.on('message', (data) => {
    try {
      const env = JSON.parse(data.toString('utf8'));
      if (env.type === TYPE_PLAYBACK_STATE_REQUEST) receivedAt.push(performance.now());
    } catch {
      // Peer already owns protocol parsing; this listener only measures timing.
    }
  });
  const c = client(`${label}-joiner`, 'viewer', { url: FROZEN_WS });
  const d = createPlaybackAcquisition({
    client: c,
    clock,
    settings: { transitionLeadMs: 150, maxFutureMs: 1150, requestTimeoutMs, backoffMs, autoStart: () => true },
    mintLineage: () => `${label}-lineage`,
  });
  const joinedClient = waitEvent(c, 'joined');
  c.connect();
  await joinedClient;
  await waitFor(() => receivedAt.length >= 5, `${label} retry requests`);
  const intervals = receivedAt.slice(1).map((at, i) => at - receivedAt[i]);
  assert(intervals.length >= 4, `${label}: at least four retry intervals`);
  const observed = median(intervals);
  const expected = requestTimeoutMs + backoffMs;
  assert(observed >= expected * 0.75 && observed <= expected * 1.25,
    `${label}: median ${observed.toFixed(1)}ms follows configured ${expected}ms`);
  console.log(`  timing discrimination ${label}: median=${observed.toFixed(1)}ms expected=${expected}ms intervals=${intervals.map((v) => v.toFixed(1)).join(',')}`);
  d.dispose();
  c.close();
  silent.close();
  await waitFor(() => rosterOfRoom(room).length === 0, `${label} room cleanup`);
  return observed;
}

export default async function playbackAcquisitionTimingSuite() {
  await check('playback acquisition timing: timeout plus backoff follows settings', async (scope) => {
    const first = await measure(scope, 100, 50, 'short');
    const second = await measure(scope, 300, 150, 'long');
    assert(first >= 112.5 && first <= 187.5, `short setting remained in its pinned interval (${first}ms)`);
    assert(second >= 337.5 && second <= 562.5, `long setting remained in its pinned interval (${second}ms)`);
    assert(first < second, `the two timing intervals discriminate settings (${first}ms < ${second}ms)`);
  });
}
