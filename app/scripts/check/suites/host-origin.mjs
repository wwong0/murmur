import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeClock, createFakeLink } from '../fake-channel.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { decodeFrame, encodeControl, parseControl } from '../../../public/lib/segment-protocol.mjs';

const text = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,\nseg-00000.m4s\n#EXT-X-ENDLIST\n';
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia.m3u8\n';
const init = new Uint8Array([0, 1, 2, 255, 9]);
const segment = new Uint8Array(256).map((_, index) => index);

function sources() {
  const values = new Map([
    ['/media/master.m3u8', { status: 200, bytes: new TextEncoder().encode(text) }],
    ['/media/master-stream.m3u8', { status: 200, bytes: new TextEncoder().encode(master) }],
    ['/media/init.mp4', { status: 200, bytes: init }],
    ['/media/seg-00000.m4s', { status: 200, bytes: segment }],
    ['/media/missing.m3u8', { status: 404, bytes: new Uint8Array() }],
    ['/media/no-map.m3u8', { status: 200, bytes: new TextEncoder().encode('#EXTM3U\n#EXTINF:1,\nseg.m4s\n') }],
  ]);
  const reads = [];
  return {
    reads,
    async read(path) {
      reads.push(path);
      const value = values.get(path);
      if (!value) throw new Error(`missing fixture ${path}`);
      return { status: value.status, bytes: value.bytes.slice() };
    },
  };
}

function receive(link) {
  const messages = [];
  link.viewer.addEventListener('message', (event) => messages.push(event.data));
  return messages;
}

function sendRequest(link, id, path, range = null) {
  link.viewer.send(encodeControl({ t: 'req', id, path, range }));
}

function controls(messages, id) {
  return messages.map((value) => typeof value === 'string' ? parseControl(value) : null).filter((value) => value?.id === id);
}

function payload(messages, id) {
  const frames = messages.map((value) => typeof value === 'string' ? null : decodeFrame(value)).filter((value) => value?.id === id);
  return frames.flatMap((frame) => [...new Uint8Array(frame.payload)]);
}

async function settle(clock, ms = 1000) {
  // A request first drains viewer -> host, then the injected source resolves
  // in microtasks, and only then can host -> viewer drain.
  clock.advance(ms);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  clock.advance(ms);
}

export default async function hostOriginSuite() {
  await check('host-origin: media playlist inlines init and preserves every other line', async () => {
    const clock = createFakeClock();
    const fixture = sources();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1000, viewerDrainBytesPerMs: 1000 });
    const messages = receive(link);
    const origin = createHostOrigin({ readSource: fixture.read, clock });
    const detach = origin.attach(link.host);
    try {
      sendRequest(link, 1, '/media/master.m3u8');
      await settle(clock);
      const body = new TextDecoder().decode(new Uint8Array(payload(messages, 1)));
      const expected = text.replace('URI="init.mp4"', `URI="data:video/mp4;base64,${btoa(String.fromCharCode(...init))}"`);
      assertEqual(body, expected, 'media playlist has exactly one rewritten URI and unchanged other lines');
      assertEqual(fixture.reads.filter((path) => path === '/media/init.mp4').length, 1, 'init is read once');
      const line = controls(messages, 1);
      assertEqual(line[0].t, 'head', 'playlist head precedes body');
      assertEqual(line.at(-1).t, 'end', 'playlist ends cleanly');
    } finally {
      detach();
      link.closeBoth();
    }
  });

  await check('host-origin: refusal, master pass-through, ranges and source status', async () => {
    const clock = createFakeClock();
    const fixture = sources();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1000, viewerDrainBytesPerMs: 1000 });
    const messages = receive(link);
    const origin = createHostOrigin({ readSource: fixture.read, clock });
    const detach = origin.attach(link.host);
    try {
      sendRequest(link, 1, '/media/no-map.m3u8');
      sendRequest(link, 2, '/media/master-stream.m3u8');
      sendRequest(link, 3, '/media/missing.m3u8');
      sendRequest(link, 4, '/media/seg-00000.m4s', { start: 10, end: 99 });
      await settle(clock);
      assertEqual(controls(messages, 1)[0].status, 500, 'a media playlist without a map is refused with 500');
      assertEqual(payload(messages, 1).length, 0, 'refused playlist has no body');
      assertEqual(new TextDecoder().decode(new Uint8Array(payload(messages, 2))), master, 'master playlist is unchanged');
      assertEqual(controls(messages, 3)[0].status, 404, 'source HTTP errors are heads');
      assertEqual(controls(messages, 4)[0].status, 206, 'range is partial content');
      assertEqual(controls(messages, 4)[0].total, 256, 'range head carries total');
      assertEqual(JSON.stringify(payload(messages, 4)), JSON.stringify([...segment.slice(10, 100)]), 'range bytes are exact');
      // Positive control recorded for the refusal guard: serving no-map text
      // unchanged makes `status === 500` red; the pass-through line was reverted
      // before the green run.
    } finally {
      detach();
      link.closeBoth();
    }
  });

  await check('host-origin: a head waits only for its own source read, not for a full buffer', async () => {
    const clock = createFakeClock();
    const fixture = sources();
    let release = null;
    const big = new Uint8Array(4_000_000);
    const readSource = (path) => {
      if (path === '/media/big.m4s') return Promise.resolve({ status: 200, bytes: big });
      if (path === '/media/held.m4s') return new Promise((resolve) => { release = () => resolve({ status: 200, bytes: segment }); });
      return fixture.read(path);
    };
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1250, viewerDrainBytesPerMs: 1250 });
    const detach = createHostOrigin({ readSource, clock }).attach(link.host);
    const heads = (id) => link.host.ledger.filter((entry) => typeof entry.data === 'string' && parseControl(entry.data)?.t === 'head' && parseControl(entry.data).id === id);
    try {
      sendRequest(link, 1, '/media/big.m4s');
      await settle(clock, 500);
      sendRequest(link, 2, '/media/held.m4s');
      await settle(clock, 1);
      assert(release !== null, 'the second source read is in flight');
      assert(link.host.bufferedAmount > 500_000, `the buffer is at the time bound, far above the floor (${link.host.bufferedAmount})`);
      assertEqual(heads(2).length, 0, 'no head before the source read resolves');
      const readAt = clock.now();
      release();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      assertEqual(heads(2).length, 1, 'the head is handed to send in the turn its read resolves');
      assertEqual(heads(2)[0].sentAt, readAt, 'no clock time passed before the head');
      // Mutation, C2 2026-09-23: deferring the head to a 20 ms clock timer turned
      // 'the head is handed to send in the turn its read resolves' red; restored, green.
    } finally {
      detach();
      link.closeBoth();
    }
  });

  await check('host-origin: rid is host-lifetime unique across channels and invalid requests are refused', async () => {
    const clock = createFakeClock();
    const fixture = sources();
    const origin = createHostOrigin({ readSource: fixture.read, clock });
    const first = createFakeLink({ clock, hostDrainBytesPerMs: 10000, viewerDrainBytesPerMs: 10000 });
    const second = createFakeLink({ clock, hostDrainBytesPerMs: 10000, viewerDrainBytesPerMs: 10000 });
    const firstMessages = receive(first);
    const secondMessages = receive(second);
    const detachFirst = origin.attach(first.host);
    const detachSecond = origin.attach(second.host);
    try {
      for (let id = 1; id <= 500; id += 1) {
        sendRequest(first, id, '/media/seg-00000.m4s');
        sendRequest(second, id, '/media/seg-00000.m4s');
      }
      first.viewer.send(encodeControl({ t: 'req', id: 9000, path: '/room.bundle.js', range: null }));
      await settle(clock, 2000);
      const rids = [...firstMessages, ...secondMessages]
        .map((value) => typeof value === 'string' ? parseControl(value) : null)
        .filter((value) => value?.t === 'head')
        .map((value) => value.rid);
      assertEqual(rids.length, 1000, 'every response has a head');
      assertEqual(new Set(rids).size, 1000, 'rids are distinct across 1000 responses and two channels');
      assertEqual(origin.stats().protocolErrors, 1, 'non-media request is a protocol error');
      assert(!fixture.reads.includes('/room.bundle.js'), 'invalid path is never read');
    } finally {
      detachFirst();
      detachSecond();
      first.closeBoth();
      second.closeBoth();
    }
  });
}
