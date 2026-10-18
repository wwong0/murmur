import { assert, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

export default async function roomRoleStatusSuite() {
  const product = await bundleProductEntry();

  await check('room role status: joined role replaces the requested role in the status line', async () => {
    const page = runEntry(product.code, { search: '?room=r&role=viewer&tab=t' });
    page.emit('status', { connected: true });
    page.emit('joined', {
      clientId: 'c-host',
      role: 'host',
      seq: 1,
      roster: [{ clientId: 'c-host', tabId: 't', role: 'host', joinedAt: 1 }],
    });
    const status = page.view().status;
    // Guarded claim: restoring `role` in both handlers makes this exact
    // shows-only assertion red; the mutation is named in the executor report.
    assert(status.includes('role "host"'), 'the status line names the held host role');
    assert(!status.includes('role "viewer"'), 'the status line does not name the requested viewer role');
  });
}
