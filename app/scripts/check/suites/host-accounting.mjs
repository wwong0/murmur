import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeClock, createFakeLink } from '../fake-channel.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { decodeFrame, encodeControl, parseControl } from '../../../public/lib/segment-protocol.mjs';

// Discrimination probes (the mutation is applied to the named protection only):
// P1 opportunity: queued body frames with a partial ledger drain at snapshot; mutation: credit on send; named red assertion: "P1 queued is not delivered"; restoration: reverted by hand to staged tree; green rerun: npm run check.
// P2 opportunity: two attached channels request one path; mutation: attach ignores viewerTag; named red assertion: "P2 attribution by channel"; restoration: reverted by hand to staged tree; green rerun: npm run check.
// P3 opportunity: an attached channel has no viewerTag; mutation: default tag to a string; named red assertion: "P3 unbound is unattributed"; restoration: reverted by hand to staged tree; green rerun: npm run check.
// P4 opportunity: abort after body admission with frames still draining; mutation: settle abort immediately; named red assertion: "P4 abort banks only delivered"; restoration: reverted by hand to staged tree; green rerun: npm run check.
// P5 opportunity: close with body frames buffered; mutation: settle close with expected; named red assertion: "P5 closed channel counts only drained"; restoration: reverted by hand to staged tree; green rerun: npm run check.

const body = new Uint8Array(300_000).map((_, index) => index & 255);

function readSource(path) {
  if (path === '/media/seg-big.m4s') return Promise.resolve({ status: 200, bytes: body });
  if (path === '/media/missing.m4s') return Promise.resolve({ status: 404, bytes: new Uint8Array() });
  return Promise.reject(new Error(`unknown fixture ${path}`));
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

async function settle(clock, ms = 500_000) {
  clock.advance(ms);
  await flush();
  clock.advance(ms);
  await flush();
}

function framePayloadBytes(link, id) {
  return link.host.ledger
    .filter((entry) => entry.drainedAt !== null && typeof entry.data !== 'string')
    .map((entry) => decodeFrame(entry.data))
    .filter((frame) => frame?.id === id)
    .reduce((sum, frame) => sum + new Uint8Array(frame.payload).byteLength, 0);
}

function records(origin) {
  return origin.snapshot().counters.responseRecords;
}

function request(link, id, path = '/media/seg-big.m4s') {
  link.viewer.send(encodeControl({ t: 'req', id, path, range: null }));
}

export default async function hostAccountingSuite() {
  await check('host-accounting: queued is not delivered until the channel drains', async () => {
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1, viewerDrainBytesPerMs: 100_000 });
    const origin = createHostOrigin({ readSource, clock, wallNow: clock.now });
    const detach = origin.attach(link.host, { viewerTag: 'c01' });
    try {
      request(link, 1);
      clock.advance(10);
      await flush();
      clock.advance(250_000);
      await flush();
      const partial = origin.snapshot();
      assert(partial.openResponses > 0, 'P1 queued is not delivered: partial response remains unsettled');
      const drained = framePayloadBytes(link, 1);
      assert(drained > 0 && drained < body.byteLength, 'P1 queued is not delivered: ledger has both drained and buffered payload');
      await settle(clock);
      const record = records(origin).find((entry) => entry.originResponseId);
      assertEqual(record.delivered, body.byteLength, 'P1 completed response records the full delivered body');
      assertEqual(record.delivered, framePayloadBytes(link, 1), 'P1 final delivered bytes equal the independent drained ledger');
    } finally {
      detach();
      link.closeBoth();
    }
  });

  await check('host-accounting: each response is attributed by its channel', async () => {
    const clock = createFakeClock();
    const first = createFakeLink({ clock, hostDrainBytesPerMs: 10_000, viewerDrainBytesPerMs: 10_000 });
    const second = createFakeLink({ clock, hostDrainBytesPerMs: 10_000, viewerDrainBytesPerMs: 10_000 });
    const origin = createHostOrigin({ readSource, clock, wallNow: clock.now });
    const detachFirst = origin.attach(first.host, { viewerTag: 'c01' });
    const detachSecond = origin.attach(second.host, { viewerTag: 'c02' });
    try {
      request(first, 1);
      request(second, 1);
      await settle(clock);
      const snapshot = origin.snapshot().counters;
      const responseRecords = snapshot.responseRecords;
      assertEqual(responseRecords.length, 2, 'P2 attribution by channel records both responses');
      assert(responseRecords.every((entry) => entry.urlPath === '/media/seg-big.m4s'), 'P2 attribution by channel keeps the same path');
      const c01 = responseRecords.find((entry) => entry.clientTag === 'c01');
      const c02 = responseRecords.find((entry) => entry.clientTag === 'c02');
      assert(c01 && c02, 'P2 attribution by channel records c01 and c02 identities');
      assertEqual(c01.delivered, body.byteLength, 'P2 attribution by channel records c01 bytes');
      assertEqual(c02.delivered, body.byteLength, 'P2 attribution by channel records c02 bytes');
      assertEqual(snapshot.byClient.c01.mediaBytesDelivered, body.byteLength, 'P2 attribution by channel has c01 bucket');
      assertEqual(snapshot.byClient.c02.mediaBytesDelivered, body.byteLength, 'P2 attribution by channel has c02 bucket');
    } finally {
      detachFirst();
      detachSecond();
      first.closeBoth();
      second.closeBoth();
    }
  });

  await check('host-accounting: an unbound channel is unattributed', async () => {
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 10_000, viewerDrainBytesPerMs: 10_000 });
    const origin = createHostOrigin({ readSource, clock, wallNow: clock.now });
    const detach = origin.attach(link.host);
    try {
      request(link, 1);
      await settle(clock);
      const snapshot = origin.snapshot().counters;
      assertEqual(snapshot.unattributedMediaBytesDelivered, body.byteLength, 'P3 unbound is unattributed: bytes enter the unattributed bucket');
      assert(!Object.hasOwn(snapshot.byClient, 'c01'), 'P3 unbound is unattributed: no client bucket is invented');
    } finally {
      detach();
      link.closeBoth();
    }
  });

  await check('host-accounting: abort banks only delivered frames, including frames drained after abort', async () => {
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1, viewerDrainBytesPerMs: 100_000 });
    const origin = createHostOrigin({ readSource, clock, wallNow: clock.now });
    const detach = origin.attach(link.host, { viewerTag: 'c01' });
    try {
      request(link, 1);
      clock.advance(10);
      await flush();
      clock.advance(70_000);
      await flush();
      const beforeAbort = framePayloadBytes(link, 1);
      assert(beforeAbort > 0 && beforeAbort < body.byteLength, 'P4 abort banks only delivered: abort occurs mid-body');
      link.viewer.send(encodeControl({ t: 'abort', id: 1 }));
      clock.advance(10);
      await flush();
      await settle(clock, 500_000);
      const record = records(origin).find((entry) => entry.originResponseId);
      const drained = framePayloadBytes(link, 1);
      assert(record.aborted, 'P4 abort banks only delivered: record is aborted');
      assertEqual(record.delivered, drained, 'P4 abort banks only delivered: delivered equals all drained payload');
      assertEqual(origin.snapshot().counters.abortedMediaBytesDelivered, drained, 'P4 abort banks only delivered: waste equals all drained payload');
      assert(record.delivered < record.expectedBytes, 'P4 abort banks only delivered: abort never records the expected body');
    } finally {
      detach();
      link.closeBoth();
    }
  });

  await check('host-accounting: closing a channel counts only payload drained before close', async () => {
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1, viewerDrainBytesPerMs: 100_000 });
    const origin = createHostOrigin({ readSource, clock, wallNow: clock.now });
    const detach = origin.attach(link.host, { viewerTag: 'c01' });
    try {
      request(link, 1);
      clock.advance(10);
      await flush();
      clock.advance(70_000);
      await flush();
      const drainedBeforeClose = framePayloadBytes(link, 1);
      assert(drainedBeforeClose > 0 && drainedBeforeClose < body.byteLength, 'P5 closed channel counts only drained: bytes remain buffered');
      link.host.close();
      const record = records(origin).find((entry) => entry.originResponseId);
      assert(record.aborted, 'P5 closed channel counts only drained: close marks response aborted');
      assertEqual(record.delivered, drainedBeforeClose, 'P5 closed channel counts only drained: delivered stops at close');
      assert(record.delivered < record.expectedBytes, 'P5 closed channel counts only drained: close does not claim expected bytes');
    } finally {
      detach();
      link.viewer.close();
    }
  });

  await check('host-accounting: completed and empty responses retain exact counter values', async () => {
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 10_000, viewerDrainBytesPerMs: 10_000 });
    const origin = createHostOrigin({ readSource, clock, wallNow: clock.now });
    const detach = origin.attach(link.host, { viewerTag: 'c01' });
    try {
      const empty = origin.snapshot();
      assertEqual(empty.openResponses, 0, 'before attach traffic, no host responses are open');
      request(link, 1, '/media/seg-big.m4s');
      request(link, 2, '/media/missing.m4s');
      await settle(clock);
      const snapshot = origin.snapshot();
      const responseRecords = snapshot.counters.responseRecords;
      const complete = responseRecords.find((entry) => entry.urlPath === '/media/seg-big.m4s');
      const missing = responseRecords.find((entry) => entry.urlPath === '/media/missing.m4s');
      assertEqual(complete.delivered, complete.expectedBytes, 'completed response records expected bytes');
      assertEqual(complete.aborted, false, 'completed response is not aborted');
      assertEqual(missing.delivered, 0, '404 head records zero delivered bytes');
      assertEqual(missing.aborted, false, '404 zero-length head completes cleanly');
      assertEqual(snapshot.counters.responseAccountingVersion, 2, 'host snapshot declares response accounting version 2');
      const first = origin.snapshot();
      const second = origin.snapshot();
      delete first.atMs;
      delete first.atIso;
      delete second.atMs;
      delete second.atIso;
      assertEqual(JSON.stringify(first), JSON.stringify(second), 'idle snapshots are equal apart from their timestamps');
    } finally {
      detach();
      link.closeBoth();
    }
  });
}
