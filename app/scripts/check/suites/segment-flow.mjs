// Deterministic sender checks. The fake link is the only transport in this file.

import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { createFakeLink, createFakeClock } from '../fake-channel.mjs';
import { createChannelSender, decodeFrame, parseControl } from '../../../public/lib/segment-protocol.mjs';

function bytes(size, seed = 1) {
  const value = new Uint8Array(size);
  for (let i = 0; i < value.length; i++) value[i] = (i + seed) & 255;
  return value;
}

function observe(link, clock) {
  const events = [];
  link.viewer.addEventListener('message', ({ data }) => events.push({ data, at: clock.now() }));
  return events;
}

function bodyFrames(channel, id) {
  return channel.ledger.filter((entry) => {
    const frame = entry.data instanceof ArrayBuffer ? decodeFrame(entry.data) : null;
    return frame?.id === id;
  });
}

function receivedFrames(events, id) {
  return events
    .map((event) => ({ ...event, frame: event.data instanceof ArrayBuffer ? decodeFrame(event.data) : null }))
    .filter((event) => event.frame?.id === id);
}

function response(sender, id, payload) {
  sender.sendControl({ t: 'head', id, rid: `test:${id}`, status: 200, length: payload.byteLength });
  sender.start(id, payload);
}

function drainedPayload(channel, id, now) {
  return bodyFrames(channel, id)
    .filter((entry) => entry.drainedAt !== null && entry.drainedAt <= now)
    .reduce((sum, entry) => sum + decodeFrame(entry.data).payload.byteLength, 0);
}

export default async function segmentFlowSuite() {
  await check('segment 2.3: tiny responses complete through the fake channel', async () => {
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1250 });
    const events = observe(link, clock);
    const sender = createChannelSender({ channel: link.host, clock });
    const first = bytes(64, 3);
    const second = bytes(256, 9);
    response(sender, 1, first);
    clock.advance(2000);
    response(sender, 2, second);
    clock.advance(2000);

    for (const [id, expected] of [[1, first], [2, second]]) {
      const controls = events.map((event) => parseControl(event.data)).filter((value) => value?.id === id);
      const frames = receivedFrames(events, id);
      assertEqual(controls[0].t, 'head', `response ${id} begins with head`);
      assertEqual(controls.at(-1).t, 'end', `response ${id} ends with end`);
      assertEqual(frames.length, 1, `response ${id} has one body frame`);
      assertEqual(JSON.stringify([...new Uint8Array(frames[0].frame.payload)]), JSON.stringify([...expected]), `response ${id} payload is exact`);
    }
    // Mutation probe: waiting on bufferedamountlow alone leaves this sub-floor tail
    // without an event; the named `response 1 ends with end` assertion went red,
    // then the wake timer was restored and this check reran green.
  });

  await check('segment 2.4: concurrent requests interleave and meet the first-byte budget', async () => {
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1250 });
    const events = observe(link, clock);
    const sender = createChannelSender({ channel: link.host, clock });
    response(sender, 1, bytes(4_000_000, 1));
    clock.advance(1000);
    const estimate = sender.stats();
    assertNear(estimate.rateBytesPerMs, 1250, 125, 'the busy drain estimate is within ten percent');
    assertNear(estimate.boundBytes, 625000, 62500, 'the 500ms bound is within ten percent');

    const t0 = clock.now();
    response(sender, 2, bytes(256, 4));
    clock.advance(3000);
    const head2 = events.find((event) => parseControl(event.data)?.t === 'head' && parseControl(event.data).id === 2);
    const end1 = events.find((event) => parseControl(event.data)?.t === 'end' && parseControl(event.data).id === 1);
    const first2 = receivedFrames(events, 2)[0];
    assert(head2 && end1 && head2.at < end1.at, 'the second head reaches the viewer before the first response ends');
    const slack = 2 * (65536 / 1250) + 20;
    assert(slack < 500 / 2, `the scaled first-byte bound has only ${slack.toFixed(1)}ms slack`);
    assert(first2 && first2.at <= t0 + 500 + slack, `the second body gets a first frame by t0 + T + slack (at ${first2?.at})`);
    // Mutation probe: admit request 2 only after request 1 ends; the named
    // `the second body gets a first frame` assertion went red at ~2300ms, then
    // round-robin admission was restored and the check reran green.
  });

  await check('segment 2.5: one channel cursor credits interleaved bodies exactly', async () => {
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1000 });
    const sender = createChannelSender({ channel: link.host, clock });
    sender.start(1, bytes(300_000, 2));
    sender.start(2, bytes(200_000, 7));
    for (const elapsed of [80, 120, 250]) {
      clock.advance(elapsed);
      assertEqual(sender.delivered(1), drainedPayload(link.host, 1, clock.now()), `request 1 credit is exact at t=${clock.now()}`);
      assertEqual(sender.delivered(2), drainedPayload(link.host, 2, clock.now()), `request 2 credit is exact at t=${clock.now()}`);
      assert(sender.delivered(1) <= 300_000 && sender.delivered(2) <= 200_000, 'bytes still buffered are not credited');
    }
    // Mutation probe: compare each request's bufferedAmount to its send-time
    // value; the named `request 2 credit is exact` assertion went red while
    // request 1 frames occupied the same channel, then the cumulative FIFO was restored.
  });

  await check('segment 2.6: abort stops admission but credits already-handed frames', async () => {
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1250 });
    const sender = createChannelSender({ channel: link.host, clock });
    sender.start(7, bytes(1_000_000, 5));
    clock.advance(260);
    const handedBeforeAbort = bodyFrames(link.host, 7).length;
    sender.abort(7);
    clock.advance(2000);
    assertEqual(bodyFrames(link.host, 7).length, handedBeforeAbort, 'no frame is handed after the host reads abort');
    assertEqual(sender.delivered(7), drainedPayload(link.host, 7, clock.now()), 'all frames that drain after abort remain credited');
    const trailers = link.host.ledger
      .filter((entry) => typeof entry.data === 'string')
      .map((entry) => parseControl(entry.data))
      .filter((value) => value?.id === 7);
    assertEqual(trailers.length, 0, 'abort sends neither end nor err');
    // Mutation probe: ignore abort; the named `no frame is handed after the host
    // reads abort` assertion went red after the next wake, then abort removal was restored.
  });

  await check('segment 2.7: floor admits on a stalled link and settings survive idle', async () => {
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 0 });
    const sender = createChannelSender({ channel: link.host, clock });
    sender.start(1, bytes(300_000));
    assertEqual(bodyFrames(link.host, 1).length, 1, 'the new sender admits exactly one frame at the floor');
    clock.advance(1000);
    assertEqual(bodyFrames(link.host, 1).length, 1, 'a stalled link does not cause speculative admission');
    link.host.setDrainRate(1250);
    clock.advance(500);
    assert(bodyFrames(link.host, 1).length > 1, 'admission resumes when the link drains');

    const preIdle = sender.stats().boundBytes;
    clock.advance(5000);
    sender.start(2, bytes(200_000, 8));
    assertNear(sender.stats().boundBytes, preIdle, preIdle * 0.1, 'idle does not collapse the remembered bound');
    // Mutation probe: count idle intervals as samples; the named `idle does not
    // collapse the remembered bound` assertion went red at the floor, then idle
    // intervals were excluded from the estimate and the check reran green.
  });

  await check('segment 2.7(c): first-byte budget and bound are constructor settings', async () => {
    for (const [budget, expectedRate] of [[200, 5000], [500, 5000]]) {
      const clock = createFakeClock();
      const link = createFakeLink({ clock, hostDrainBytesPerMs: expectedRate });
      const events = observe(link, clock);
      const sender = createChannelSender({ channel: link.host, clock, settings: { firstByteBudgetMs: budget } });
      sender.start(1, bytes(12_000_000, budget));
      clock.advance(1000);
      const stats = sender.stats();
      assertNear(stats.rateBytesPerMs, expectedRate, expectedRate * 0.1, `T=${budget} rate estimate is pinned`);
      assertNear(stats.boundBytes, expectedRate * budget, expectedRate * budget * 0.1, `T=${budget} bound is rate times T`);
      const t0 = clock.now();
      sender.start(2, bytes(256, budget + 1));
      clock.advance(1000);
      const first = receivedFrames(events, 2)[0];
      const slack = 2 * (65536 / expectedRate) + 20;
      assert(slack < budget / 2, `T=${budget} slack remains below T/2`);
      assert(first && first.at <= t0 + budget + slack, `T=${budget} first byte respects the configured budget`);
    }
    // Mutation probe: read T from a fixed module value of 500; the named
    // `T=200 bound is rate times T` assertion went red, then constructor settings
    // were restored and both runs reran green.
  });
}
