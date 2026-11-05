// Fair turns at the host's shared bucket, and the
// urgent class served ahead of prefetch — across channels through the arbiter,
// and within one channel through the sender's own selection.

import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeClock, createFakeLink } from '../fake-channel.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { createSendArbiter } from '../../../public/lib/send-arbiter.mjs';
import { createChannelSender, decodeFrame, encodeControl, parseControl } from '../../../public/lib/segment-protocol.mjs';

const BIG_BYTES = 60_000_000;
const URGENT_BYTES = 1_300_000;

async function flush(turns = 20) {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

function bodyFrames(channel) {
  return channel.ledger.filter((entry) => typeof entry.data !== 'string');
}

function endAt(channel, id) {
  return channel.ledger.find((entry) => typeof entry.data === 'string'
    && parseControl(entry.data)?.t === 'end' && parseControl(entry.data).id === id)?.sentAt ?? null;
}

// Links that drain 600 000 B/s together until the estimate forms, then far faster,
// so only the shared bucket, at 0.85 × the estimate, limits what each channel gets.
async function pacedHost(clock, count) {
  const sources = { '/media/big.m4s': new Uint8Array(BIG_BYTES), '/media/urgent.m4s': new Uint8Array(URGENT_BYTES) };
  const origin = createHostOrigin({ readSource: async (path) => ({ status: 200, bytes: sources[path] }), clock, pace: { fraction: 0.85 } });
  const links = Array.from({ length: count }, () => createFakeLink({ clock, hostDrainBytesPerMs: 600 / count, viewerDrainBytesPerMs: 1_000_000 }));
  const detaches = links.map((link) => origin.attach(link.host));
  links.forEach((link, index) => link.viewer.send(encodeControl({ t: 'req', id: index + 1, path: '/media/big.m4s', range: null })));
  clock.advance(1);
  await flush();
  clock.advance(6000);
  const paceBytesPerMs = origin.pace().paceBytesPerSecond / 1000;
  for (const link of links) link.host.setDrainRate(5000);
  clock.advance(2000);
  return {
    origin,
    links,
    paceBytesPerMs,
    cleanup() {
      detaches.forEach((detach) => detach());
      links.forEach((link) => link.closeBoth());
    },
  };
}

export default async function sendArbiterSuite() {
  await check('send-arbiter: urgent, near and normal classes drain in strict order', async () => {
    const clock = createFakeClock();
    const sent = [];
    const pace = { available: () => ({ ok: true }), take: () => {} };
    const arbiter = createSendArbiter({ pace, clock });
    const add = (label, className, count) => {
      let left = count;
      arbiter.register({
        offer: () => (left > 0 ? className : null),
        admitOne: () => {
          left -= 1;
          sent.push(label);
          return 1;
        },
      });
    };
    add('normal', 'normal', 2);
    add('near-a', 'near', 2);
    add('near-b', 'near', 2);
    add('urgent', 'urgent', 2);
    arbiter.register({ offer: () => null, admitOne: () => 0 }).poke();
    assertEqual(JSON.stringify(sent), JSON.stringify([
      'urgent', 'urgent', 'near-a', 'near-b', 'near-a', 'near-b', 'normal', 'normal',
    ]), 'every urgent chunk goes first, then near chunks take turns, then normal');
    // Mutation (a) proof, T6: the opportunity is four handles offering urgent,
    // near (two turns), and normal; the boundary is strict urgent/near/normal
    // order. Setting CLASS_RANK.near = 1 made the named assertion red (expected
    // urgent, urgent, near-a, near-b, near-a, near-b, normal, normal; got normal
    // before near). `git checkout -- app/public/lib/send-arbiter.mjs` restored
    // the staged copy, and the rerun was green.
  });

  await check('send-arbiter: every channel waiting at the shared bucket gets its turn', async () => {
    const clock = createFakeClock();
    const { links, paceBytesPerMs, cleanup } = await pacedHost(clock, 5);
    try {
      assert(paceBytesPerMs > 0, `the pace is in force (${paceBytesPerMs} B/ms)`);
      const from = clock.now();
      clock.advance(20_000);
      const counts = [];
      for (const link of links) {
        const sent = bodyFrames(link.host).filter((entry) => entry.sentAt >= from).map((entry) => entry.sentAt);
        let gap = 0;
        let previous = from;
        for (const at of sent) {
          gap = Math.max(gap, at - previous);
          previous = at;
        }
        gap = Math.max(gap, clock.now() - previous);
        counts.push(sent.length);
        // Five channels at about 7.8 chunks/s is one turn each 640 ms; 1 s is well
        // inside the engine's 3 s no-bytes timeout and well outside a fair turn.
        assert(gap <= 1000, `no channel waits more than 1 000 ms for a chunk (gap ${gap} ms)`);
      }
      assert(Math.max(...counts) - Math.min(...counts) <= 1, `chunk counts differ by at most one (${counts.join(', ')})`);
      // Mutation probe, staged: send-arbiter.mjs's pump with the rotation line
      // removed, so the first offering handle always wins. `npm run check` turned
      // 'no channel waits more than 1 000 ms' red (gap 20 000 ms: one channel took
      // every chunk, as before T13). Reverted; check green again.
    } finally {
      cleanup();
    }
  });

  for (const urgent of [true, false]) {
    await check(`send-arbiter: a request ${urgent ? 'marked urgent takes every chunk until it ends' : 'not marked urgent shares the bucket'}`, async () => {
      const clock = createFakeClock();
      const { origin, links, paceBytesPerMs, cleanup } = await pacedHost(clock, 3);
      try {
        const third = links[2];
        const request = { t: 'req', id: 99, path: '/media/urgent.m4s', range: null };
        third.viewer.send(encodeControl(urgent ? { ...request, urgent: true } : request));
        clock.advance(1);
        await flush();
        const startedAt = clock.now();
        // Long enough for the unmarked pair, a sixth of the bucket, to end too.
        clock.advance(20_000);
        const urgentFrames = bodyFrames(third.host).filter((entry) => decodeFrame(entry.data).id === 99);
        const ended = endAt(third.host, 99);
        assert(ended !== null, 'the third body ended inside the run');
        const firstAt = urgentFrames[0].sentAt;
        const others = links.slice(0, 2).flatMap((link) => bodyFrames(link.host))
          .filter((entry) => entry.sentAt > firstAt && entry.sentAt < ended).length;
        assertEqual(origin.stats().urgentResponses, urgent ? 1 : 0, 'the host counted the urgent response');
        if (urgent) {
          assertEqual(others, 0, 'no other channel got a chunk while the urgent body had one to send');
          const bound = (URGENT_BYTES + 2 * 65_528) / paceBytesPerMs;
          assert(ended - startedAt <= bound, `the urgent body ends within its bytes at the pace (${ended - startedAt} ms ≤ ${bound} ms)`);
        } else {
          assert(others >= urgentFrames.length, `the other two channels shared the bucket (${others} against ${urgentFrames.length})`);
        }
        // Mutation probe, staged: send-arbiter.mjs's CLASS_RANK gave 'urgent' the
        // rank of 'normal'. `npm run check` turned 'no other channel got a chunk
        // while the urgent body had one to send' red (38 chunks went to the other
        // two channels). Reverted; check green again.
      } finally {
        cleanup();
      }
    });
  }

  await check('send-arbiter: within one channel an urgent body goes before the body in progress', async () => {
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 200, viewerDrainBytesPerMs: 1_000_000 });
    const sender = createChannelSender({ channel: link.host, clock });
    try {
      sender.start(1, new Uint8Array(2_000_000));
      clock.advance(500);
      sender.start(2, new Uint8Array(400_000), { urgent: true });
      clock.advance(5000);
      const frames = bodyFrames(link.host).map((entry) => ({ id: decodeFrame(entry.data).id, at: entry.sentAt }));
      const first = frames.findIndex((frame) => frame.id === 2);
      const last = frames.map((frame) => frame.id).lastIndexOf(2);
      assert(first !== -1 && endAt(link.host, 2) !== null, 'the urgent body was sent in full');
      const interleaved = frames.slice(first, last + 1).filter((frame) => frame.id !== 2).length;
      assertEqual(interleaved, 0, 'no chunk of the body in progress went between the urgent body\'s chunks');
      assert(frames.slice(last + 1).some((frame) => frame.id === 1), 'the body in progress resumed after it');
      // Mutation probe, staged: segment-protocol.mjs's select() returning the
      // first body in turn whatever its class. `npm run check` turned 'no chunk
      // of the body in progress went between' red (6 interleaved), and the
      // across-channel case with it. Reverted; check green again.
    } finally {
      sender.close();
      link.closeBoth();
    }
  });

  await check('send-arbiter: a refused pace arms one timer, and a poke during a pump does not nest', async () => {
    const clock = createFakeClock();
    let armed = 0;
    const counted = { ...clock, setTimeout: (fn, ms) => { armed += 1; return clock.setTimeout(fn, ms); } };
    let open = false;
    const pace = { available: () => (open ? { ok: true } : { ok: false, waitMs: 50 }), take: () => {} };
    const arbiter = createSendArbiter({ pace, clock: counted });
    let depth = 0;
    let deepest = 0;
    let left = 3;
    let turn = null;
    turn = arbiter.register({
      offer: () => (left > 0 ? 'normal' : null),
      admitOne: () => {
        depth += 1;
        deepest = Math.max(deepest, depth);
        turn.poke();
        left -= 1;
        depth -= 1;
        return 10;
      },
    });
    turn.poke();
    turn.poke();
    turn.poke();
    assertEqual(armed, 1, 'three refused pokes armed one timer');
    assert(arbiter.pending().timerArmed, 'the timer is armed');
    open = true;
    clock.advance(50);
    assertEqual(left, 0, 'the timer\'s poke admitted every offered chunk');
    assertEqual(deepest, 1, 'a poke from inside admitOne did not nest a pump');
  });
}
