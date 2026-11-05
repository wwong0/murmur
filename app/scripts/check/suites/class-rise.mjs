// A request whose class rises is told to the host, the host moves the rest
// of the body, and the receipt keeps each rise. Pure: a fake clock and fake channels.

import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeClock, createFakeLink } from '../fake-channel.mjs';
import { createFakeRoomClient, createFakeRtcFactory } from '../fake-rtc.mjs';
import { createHostLink } from '../../../public/lib/host-link.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { decodeFrame, encodeControl } from '../../../public/lib/segment-protocol.mjs';

const WALL_BASE_MS = 1_700_000_000_000;
const NEAR_AFTER_MS = 3000;
const URGENT_AFTER_MS = 10_000;
const BIG_BYTES = 1_000_000;
const SMALL_BYTES = 100;
const HOST_DRAIN_BYTES_PER_MS = 200;
const RUN_LIMIT_MS = 30_000;
const STEP_MS = 50;

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

async function settle(clock, ms) {
  for (let left = ms; left > 0; left -= STEP_MS) {
    await flush();
    clock.advance(Math.min(STEP_MS, left));
  }
  await flush();
}

const strings = (channel) => channel.ledger.filter((entry) => typeof entry.data === 'string').map((entry) => JSON.parse(entry.data));
const frames = (channel) => channel.ledger.filter((entry) => typeof entry.data !== 'string').map((entry) => decodeFrame(entry.data));

// A viewer link over a real host origin whose source answers only once released.
function linkRig(urgency) {
  const clock = createFakeClock();
  const client = createFakeRoomClient({ clientId: 'viewer-1' });
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const origin = createHostOrigin({ clock, readSource: async () => (await gate, { status: 200, bytes: new Uint8Array(512) }) });
  const sent = [];
  const rtc = createFakeRtcFactory({
    clock,
    hostDrainBytesPerMs: 1000,
    viewerDrainBytesPerMs: 1000,
    onLink(link) {
      link.host.addEventListener('message', ({ data }) => { if (typeof data === 'string') sent.push(JSON.parse(data)); });
      origin.attach(link.host);
    },
  });
  const originalSend = client.send;
  client.send = (message) => {
    originalSend(message);
    if (message.type === 'host-link-offer') {
      queueMicrotask(() => client.emit('host-link-answer', { from: message.to, payload: { linkId: message.payload.linkId, sdp: 'fake-answer' } }));
    }
    return message;
  };
  const link = createHostLink({ client, RTCPeerConnection: rtc.RTCPeerConnection, clock, urgency, wallNow: () => WALL_BASE_MS + clock.now() });
  client.emitEvent('joined', { clientId: 'viewer-1', roster: [{ clientId: 'host-1', role: 'host' }] });
  const classes = () => sent.filter((control) => control.t === 'class');
  return { clock, link, origin, release, classes };
}

async function openedRig(urgency) {
  const rig = linkRig(urgency);
  await flush();
  assertEqual(rig.link.snapshot().state, 'open', 'link reaches open');
  return rig;
}

const ask = (rig) => rig.link.request({ path: '/media/seg-00001.m4s', handlers: {} });

async function finish(rig) {
  rig.release();
  await settle(rig.clock, 200);
}

// One host channel, two bodies asked in the same turn. `raise` is sent for body 1
// once it has framed two chunks; the result is body 1's remaining frames against body 2's.
async function hostRun({ first = {}, second = {}, raise = null, source = null }) {
  const clock = createFakeClock();
  const sources = { '/media/a.m4s': new Uint8Array(BIG_BYTES), '/media/b.m4s': new Uint8Array(BIG_BYTES) };
  const origin = createHostOrigin({ clock, readSource: async (path) => (await source?.(path), { status: 200, bytes: sources[path] }) });
  const link = createFakeLink({ clock, hostDrainBytesPerMs: HOST_DRAIN_BYTES_PER_MS, viewerDrainBytesPerMs: 1_000_000 });
  const detach = origin.attach(link.host);
  const idsNow = () => frames(link.host).map((frame) => frame.id);
  try {
    link.viewer.send(encodeControl({ t: 'req', id: 1, path: '/media/a.m4s', range: null, ...first }));
    link.viewer.send(encodeControl({ t: 'req', id: 2, path: '/media/b.m4s', range: null, ...second }));
    await settle(clock, 1);
    for (let elapsed = 0; idsNow().filter((id) => id === 1).length < 2 && elapsed < RUN_LIMIT_MS; elapsed += 10) await settle(clock, 10);
    if (raise) {
      link.viewer.send(encodeControl({ t: 'class', id: 1, ...raise }));
      await settle(clock, 1);
    }
    const before = idsNow().length;
    for (let elapsed = 0; elapsed < RUN_LIMIT_MS; elapsed += 10) await settle(clock, 10);
    const after = idsNow().slice(before);
    return { origin, after, lastOne: after.lastIndexOf(1), firstTwo: after.indexOf(2), strings: strings(link.host) };
  } finally {
    detach();
    link.closeBoth();
  }
}

function assertOneBeforeTwo(run, label) {
  assert(run.lastOne !== -1, `${label}: body 1 had chunks left when the class arrived`);
  assert(run.after.includes(2), `${label}: body 2 was still being sent after`);
  assert(run.firstTwo > run.lastOne, `${label}: every remaining chunk of body 1 went before body 2's (last of 1 at ${run.lastOne}, first of 2 at ${run.firstTwo})`);
}

export default async function classRiseSuite() {
  await check('class-rise: the receipt records each rise, and the host was told in order', async () => {
    let cls = null;
    const rig = await openedRig(() => cls);
    ask(rig);
    await settle(rig.clock, NEAR_AFTER_MS);
    cls = 'near';
    assertEqual(rig.link.reclassify(), 1, 'one class control sent');
    await settle(rig.clock, URGENT_AFTER_MS - NEAR_AFTER_MS);
    cls = 'urgent';
    assertEqual(rig.link.reclassify(), 1, 'one class control sent');
    await settle(rig.clock, 10);
    assertEqual(JSON.stringify(rig.classes()), JSON.stringify([{ t: 'class', id: 1, near: true }, { t: 'class', id: 1, urgent: true }]), 'the channel saw near, then urgent');
    await finish(rig);
    const receipt = rig.link.receipts().records[0];
    assertEqual(JSON.stringify({ urgent: receipt.urgent, near: receipt.near, finished: receipt.finished }), JSON.stringify({ urgent: false, near: false, finished: true }), 'the receipt keeps the class at the ask');
    assertEqual(JSON.stringify(receipt.rises), JSON.stringify([
      { class: 'near', atMs: WALL_BASE_MS + NEAR_AFTER_MS },
      { class: 'urgent', atMs: WALL_BASE_MS + URGENT_AFTER_MS },
    ]), 'the receipt lists both rises with their instants');
    rig.link.close();
  });

  await check('class-rise: a class never falls', async () => {
    let cls = 'near';
    const rig = await openedRig(() => cls);
    ask(rig);
    for (const next of [null, 'near']) {
      cls = next;
      assertEqual(rig.link.reclassify(), 0, `urgency ${next}: nothing sent`);
    }
    await settle(rig.clock, 10);
    assertEqual(rig.classes().length, 0, 'no class control reached the channel');
    cls = 'urgent';
    assertEqual(rig.link.reclassify(), 1, 'positive control: a higher class is sent');
    await finish(rig);
    assertEqual(JSON.stringify(rig.link.receipts().records[0].rises.map((rise) => rise.class)), JSON.stringify(['urgent']), 'only the rise is recorded');
    // Mutation (T4), staged: sending when `cls` differs from the current class rather
    // than outranks it turned this red; see evidence/mutations.md.
    rig.link.close();
  });

  await check('class-rise: an ended request is not re-evaluated', async () => {
    for (const ended of [true, false]) {
      let cls = null;
      const rig = await openedRig(() => cls);
      ask(rig);
      if (ended) await finish(rig);
      cls = 'urgent';
      assertEqual(rig.link.reclassify(), ended ? 0 : 1, ended ? 'ended: nothing re-evaluated' : 'positive control: the same sequence unended sends');
      await settle(rig.clock, 10);
      assertEqual(rig.classes().length, ended ? 0 : 1, `${ended ? 'ended' : 'unended'}: class controls at the channel`);
      rig.link.close();
    }
  });

  await check('class-rise: a prefetch that comes due is sent ahead of other prefetch', async () => {
    const control = await hostRun({});
    assert(control.firstTwo !== -1 && control.firstTwo < control.lastOne, 'without a class the two bodies alternate');
    assertOneBeforeTwo(await hostRun({ raise: { near: true } }), 'normal to near');
  });

  await check('class-rise: a near body becomes urgent', async () => {
    const control = await hostRun({ first: { near: true }, second: { near: true } });
    assert(control.firstTwo < control.lastOne, 'without a class two near bodies alternate');
    assertOneBeforeTwo(await hostRun({ first: { near: true }, second: { near: true }, raise: { urgent: true } }), 'near to urgent');
  });

  await check('class-rise: the host never lowers a class', async () => {
    const run = await hostRun({ first: { urgent: true }, second: { near: true }, raise: { near: true } });
    assertOneBeforeTwo(run, 'urgent kept after a near class');
    // Mutation (T5), staged: assigning the class unconditionally in raise() turned this red.
  });

  await check('class-rise: a class before the read resolves is answered in that class', async () => {
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const clock = createFakeClock();
    const origin = createHostOrigin({ clock, readSource: async () => (await gate, { status: 200, bytes: new Uint8Array(SMALL_BYTES) }) });
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1000, viewerDrainBytesPerMs: 1000 });
    const detach = origin.attach(link.host);
    try {
      link.viewer.send(encodeControl({ t: 'req', id: 1, path: '/media/a.m4s', range: null }));
      await settle(clock, 1);
      link.viewer.send(encodeControl({ t: 'class', id: 1, near: true }));
      await settle(clock, 1);
      release();
      await settle(clock, 100);
      assertEqual(JSON.stringify({ near: origin.stats().nearResponses, urgent: origin.stats().urgentResponses }), JSON.stringify({ near: 1, urgent: 0 }), 'the response started near');
      assert(strings(link.host).some((control) => control.t === 'end' && control.id === 1), 'the body ended');
    } finally {
      detach();
      link.closeBoth();
    }
  });

  await check('class-rise: a class for a finished body is ignored', async () => {
    const clock = createFakeClock();
    const origin = createHostOrigin({ clock, readSource: async () => ({ status: 200, bytes: new Uint8Array(SMALL_BYTES) }) });
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1000, viewerDrainBytesPerMs: 1000 });
    const detach = origin.attach(link.host);
    try {
      link.viewer.send(encodeControl({ t: 'req', id: 1, path: '/media/a.m4s', range: null }));
      await settle(clock, 500);
      assert(strings(link.host).some((control) => control.t === 'end' && control.id === 1), 'body 1 ended');
      const framesBefore = frames(link.host).length;
      const errorsBefore = origin.stats().protocolErrors;
      link.viewer.send(encodeControl({ t: 'class', id: 1, urgent: true }));
      await settle(clock, 50);
      link.viewer.send(encodeControl({ t: 'req', id: 2, path: '/media/b.m4s', range: null }));
      await settle(clock, 500);
      const second = frames(link.host).filter((frame) => frame.id === 2);
      assertEqual(frames(link.host).filter((frame) => frame.id === 1).length, framesBefore, 'no further frame with the first id');
      assert(!strings(link.host).some((control) => control.t === 'err'), 'no err control');
      assertEqual(origin.stats().protocolErrors, errorsBefore, 'protocolErrors unchanged');
      assertEqual(second.reduce((total, frame) => total + frame.payload.byteLength, 0), SMALL_BYTES, 'the second body arrived whole');
      // Mutation (T5), staged: deleting `if (!body) return false` in raise() turned this red.
    } finally {
      detach();
      link.closeBoth();
    }
  });

  await check('class-rise: a class for an unknown id is ignored and a malformed id is a protocol error', async () => {
    const clock = createFakeClock();
    const origin = createHostOrigin({ clock, readSource: async () => ({ status: 200, bytes: new Uint8Array(SMALL_BYTES) }) });
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1000, viewerDrainBytesPerMs: 1000 });
    const detach = origin.attach(link.host);
    try {
      link.viewer.send(encodeControl({ t: 'class', id: 77, urgent: true }));
      await settle(clock, 10);
      assertEqual(origin.stats().protocolErrors, 0, 'an id never asked is not an error');
      link.viewer.send(encodeControl({ t: 'class', id: -1, urgent: true }));
      await settle(clock, 10);
      assertEqual(origin.stats().protocolErrors, 1, 'a malformed id counts one');
    } finally {
      detach();
      link.closeBoth();
    }
  });
}
