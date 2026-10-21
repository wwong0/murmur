import { assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { leaveWarns } from '../../../public/lib/leave-warning.mjs';

export default async function leaveWarningSuite() {
  await check('leave-warning: only a playing host warns', async () => {
    for (const [role, playing, expected] of [
      ['host', true, true], ['host', false, false], ['viewer', true, false], ['viewer', false, false], ['unknown', true, false],
    ]) assertEqual(leaveWarns({ role, playing }), expected, `${role} ${playing}`);
  });

  const product = await bundleProductEntry();
  await check('leave-warning entry: beforeunload is prevented only for a playing host', async () => {
    const host = runEntry(product.code, { role: 'host' });
    host.resolveSole({ nowMs: 10_000 });
    assertEqual(host.fireWindow('beforeunload').defaultPrevented, true, 'playing host is warned');

    const state = host.app.playbackState();
    host.deliver({
      type: 'playback-operation', from: 'c1', seq: 3, ts: { recv: 11_000 },
      payload: { kind: 'pause', basis: { lineage: state.lineage, version: state.version }, atSharedMs: 11_000 },
    });
    assertEqual(host.fireWindow('beforeunload').defaultPrevented, false, 'paused host is not warned');

    const viewer = runEntry(product.code, { role: 'viewer' });
    viewer.emit('joined', { clientId: 'c1', role: 'viewer', seq: 1, roster: [{ clientId: 'c1', tabId: 't', role: 'viewer', joinedAt: 1 }] });
    assertEqual(viewer.fireWindow('beforeunload').defaultPrevented, false, 'viewer is not warned');
  });
}
