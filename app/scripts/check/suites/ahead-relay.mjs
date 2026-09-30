// T6 (design.md D5; tasks.md 3.2): the `ahead` envelope type and its relay to
// the host. Nothing under `server/**` — the server blind-relays any directed
// type the way it already relays `host-link-offer`/`host-link-ice` (7a).

import { assert, assertEqual, check } from '../harness.mjs';
import { TYPE_AHEAD, buildAheadEnvelope, readAheadReport } from '../../../public/lib/envelope.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

async function drain() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

export default async function aheadRelaySuite() {
  await check("ahead-relay: a viewer's ahead envelope reaches the host intact, and not a second viewer", async ({ member }) => {
    const host = await member('host', 'host');
    const viewer = await member('viewer', 'viewer');
    const other = await member('other', 'viewer');
    viewer.send(buildAheadEnvelope({ to: host.clientId, lineage: 'lineage-x', version: 5, heldAheadMs: 4200 }));
    const received = await host.next((entry) => entry.type === TYPE_AHEAD);
    assertEqual(received.from, viewer.clientId, 'the relayed envelope names the viewer as sender');
    assertEqual(received.payload.lineage, 'lineage-x', 'lineage is carried intact');
    assertEqual(received.payload.version, 5, 'version is carried intact');
    assertEqual(received.payload.heldAheadMs, 4200, 'heldAheadMs is carried intact');
    await other.none((entry) => entry.type === TYPE_AHEAD, 250);
  });

  await check('ahead-relay: readAheadReport rejects each malformed field, fixtures differing in one field only', async () => {
    const base = { from: 'v1', payload: { lineage: 'L', version: 3, heldAheadMs: 1000 } };
    assert(readAheadReport(base) !== null, 'the base fixture is valid');
    assertEqual(JSON.stringify(readAheadReport(base)), JSON.stringify({ from: 'v1', lineage: 'L', version: 3, heldAheadMs: 1000 }), 'a valid report reads its four fields exactly');

    assertEqual(readAheadReport({ ...base, from: undefined }), null, 'a missing from is rejected');
    assertEqual(readAheadReport({ ...base, from: '' }), null, 'an empty from is rejected');
    assertEqual(readAheadReport({ ...base, payload: { ...base.payload, lineage: '' } }), null, 'an empty lineage is rejected');
    assertEqual(readAheadReport({ ...base, payload: { ...base.payload, lineage: 3 } }), null, 'a non-string lineage is rejected');
    assertEqual(readAheadReport({ ...base, payload: { ...base.payload, version: 3.5 } }), null, 'a non-integer version is rejected');
    assertEqual(readAheadReport({ ...base, payload: { ...base.payload, version: '3' } }), null, 'a non-numeric version is rejected');
    assertEqual(readAheadReport({ ...base, payload: { ...base.payload, heldAheadMs: -1 } }), null, 'a negative heldAheadMs is rejected');
    assertEqual(readAheadReport({ ...base, payload: { ...base.payload, heldAheadMs: Infinity } }), null, 'a non-finite heldAheadMs is rejected');
    assertEqual(readAheadReport({ ...base, payload: { ...base.payload, heldAheadMs: '1000' } }), null, 'a non-numeric heldAheadMs is rejected');
    assertEqual(readAheadReport(null), null, 'a null envelope is rejected');
    assertEqual(readAheadReport({ ...base, payload: null }), null, 'a null payload is rejected');
    // The host's rule ignoring a report for another lineage or version is T8's
    // stale-report scenario (scripts/check/suites/hold-resume.mjs) — not
    // duplicated here, since `readAheadReport` itself carries no identity check.
  });

  const product = await bundleProductEntry();

  await check('ahead-relay entry: a host ignores malformed reports and publishes their count', async () => {
    const page = runEntry(product.code, {
      role: 'host',
      settings: { delivery: 'host', trackerUrl: 'ws://tracker.test:1', iceServers: [] },
    });
    await drain();
    page.resolveSole({ clientId: 'host-1', nowMs: 10_000 });
    page.deliver({ type: TYPE_AHEAD, from: 'v1', payload: { lineage: 'L', version: 1, heldAheadMs: 'not-a-number' } });
    assertEqual(page.app.resumes().malformedReports, 1, 'one malformed report is counted at the host');
    page.deliver({ type: TYPE_AHEAD, from: 'v1', payload: { lineage: 'L', version: 1, heldAheadMs: 4000 } });
    assertEqual(page.app.resumes().malformedReports, 1, 'a later valid report does not increment the malformed count');
  });
}
