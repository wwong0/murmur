import { WebSocket } from 'ws';
import { assert, assertEqual, check } from '../harness.mjs';
import { mediaMsAt } from '../../../public/lib/playback-state.mjs';
import { createPlaybackAcquisition } from '../../../public/lib/playback-acquisition.mjs';
import { createRoomClient } from '../../../public/lib/room-client.mjs';
import { startRoomServer } from '../../../server/room-server.mjs';
import { mediaDir } from '../fixtures.mjs';

const SETTINGS = Object.freeze({
  transitionLeadMs: 0,
  maxFutureMs: 1150,
  requestTimeoutMs: 200,
  backoffMs: 10,
  autoStart: () => true,
});

function waitFor(test, label, timeoutMs = 3000) {
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

function acquisition(client, label) {
  let lineage = 0;
  return createPlaybackAcquisition({
    client,
    clock: { sharedNow: () => performance.timeOrigin + performance.now() },
    settings: SETTINGS,
    mintLineage: () => `restart-${label}-${lineage++}`,
  });
}

function connect(client) {
  const joined = new Promise((resolve) => client.onEvent('joined', resolve));
  client.connect();
  return joined;
}

export default async function serverRestartSuite() {
  await check('server restart: both members recreate one preserved mapping lineage', async ({ room }) => {
    const first = startRoomServer({ port: 0, mediaDir, livenessMs: 120, quiet: true });
    let second = null;
    const clients = [];
    const acquisitions = [];
    let offHostJoined = () => {};
    let offViewerJoined = () => {};
    try {
      const firstPort = await first.ready;
      const firstUrl = `ws://127.0.0.1:${firstPort}/ws`;
      const host = createRoomClient({ url: firstUrl, room, tabId: 'restart-host', role: 'host', WebSocketImpl: WebSocket });
      const viewer = createRoomClient({ url: firstUrl, room, tabId: 'restart-viewer', role: 'viewer', WebSocketImpl: WebSocket });
      clients.push(host, viewer);
      const hostAcquisition = acquisition(host, 'host');
      const viewerAcquisition = acquisition(viewer, 'viewer');
      acquisitions.push(hostAcquisition, viewerAcquisition);

      await Promise.all([connect(host), connect(viewer)]);
      await waitFor(() => hostAcquisition.state !== null && viewerAcquisition.state !== null, 'initial members to resolve');
      const s0 = hostAcquisition.state;
      assert(s0, 'the initial host state exists');
      assertEqual(viewerAcquisition.state.lineage, s0.lineage, 'the initial members share one lineage');
      assertEqual(viewerAcquisition.state.controlMode, s0.controlMode, 'the initial members share control mode');
      assertEqual(viewerAcquisition.state.current.playing, s0.current.playing, 'the initial members share playing state');
      let rejoined = 0;
      offHostJoined = host.onEvent('joined', () => { rejoined += 1; });
      offViewerJoined = viewer.onEvent('joined', () => { rejoined += 1; });

      await first.close();
      second = startRoomServer({ port: firstPort, mediaDir, livenessMs: 120, quiet: true });
      await second.ready;

      const resolvedAt = Date.now();
      await waitFor(() => rejoined === 2 && hostAcquisition.state !== null && viewerAcquisition.state !== null, 'both members to rejoin and resolve after restart', 10_000);
      const resolveMs = Date.now() - resolvedAt;
      const hostState = hostAcquisition.state;
      const viewerState = viewerAcquisition.state;
      assert(hostState && viewerState, `both members resolved after ${resolveMs}ms`);
      assertEqual(hostState.lineage, viewerState.lineage, `both members share one restarted lineage after ${resolveMs}ms`);
      assert(hostState.lineage !== s0.lineage, `recreation mints a lineage different from S0 (${hostState.lineage} vs ${s0.lineage})`);
      assertEqual(hostState.controlMode, s0.controlMode, 'recreation preserves control mode');
      assertEqual(hostState.current.playing, s0.current.playing, 'recreation preserves playing state');
      // Both servers run in one process and therefore share this timebase; this
      // check proves protocol continuity, not the cross-process clock argument.
      const now = performance.timeOrigin + performance.now();
      const instants = [now, now + 5000, now + 10000];
      const mappings = [];
      for (const instant of instants) {
        const hostAt = mediaMsAt(hostState, instant);
        const viewerAt = mediaMsAt(viewerState, instant);
        const s0At = mediaMsAt(s0, instant);
        mappings.push(`${hostAt}/${viewerAt}/${s0At}`);
        assertEqual(hostAt, s0At, `host mapping survives restart at ${instant}`);
        assertEqual(viewerAt, s0At, `viewer mapping survives restart at ${instant}`);
      }
      console.log(`server restart reading: resolved=${resolveMs}ms, S0=${s0.lineage}/${s0.controlMode}/${s0.current.playing}, new=${hostState.lineage}, mappings=${mappings.join('|')}`);
    } finally {
      for (const acquisition of acquisitions) acquisition.dispose();
      offHostJoined();
      offViewerJoined();
      for (const client of clients) client.close();
      await second?.close();
      await first.close();
    }
  });
}
