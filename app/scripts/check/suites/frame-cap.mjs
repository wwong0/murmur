import { assert, assertEqual, check, Peer } from '../harness.mjs';
import { mediaDir } from '../fixtures.mjs';
import { startRoomServer } from '../../../server/room-server.mjs';
import { ADDR_ROOM, buildClientEnvelope } from '../../../public/lib/envelope.mjs';

function exactFrame(cap) {
  const base = buildClientEnvelope({ type: 'x', to: ADDR_ROOM, payload: {} });
  return JSON.stringify({ ...base, type: 'x'.repeat(cap - JSON.stringify(base).length + 1) });
}

async function withServer(options, fn) {
  const server = startRoomServer({
    port: 0,
    mediaDir,
    quiet: true,
    envelopeBurst: 1000,
    joinBurst: 1000,
    ...options,
  });
  try {
    const url = `ws://127.0.0.1:${await server.ready}/ws`;
    return await fn(server, url);
  } finally {
    await server.close();
  }
}

export default async function frameCapSuite() {
  await check('frame cap: an oversized frame closes only its sender and leaves the room', async () => {
    await withServer({ frameCapBytes: 4096 }, async (server, url) => {
      const a = await Peer.open(url, 'frame-a');
      const b = await Peer.open(url, 'frame-b');
      const c = await Peer.open(url, 'frame-c');
      try {
        await a.join({ room: 'frame-room', tabId: 'a', role: 'host' });
        await b.join({ room: 'frame-room', tabId: 'b', role: 'viewer' });
        await c.join({ room: 'frame-room', tabId: 'c', role: 'viewer' });
        a.sendRaw('x'.repeat(4097));
        assertEqual(await a.waitClosed(), 1009, 'oversized frame close code');
        await b.next((env) => env.type === 'presence' && env.payload.event === 'leave');
        await c.next((env) => env.type === 'presence' && env.payload.event === 'leave');
        assert(!b.closed && !c.closed, 'other members stay connected');
        assertEqual(server.rooms.get('frame-room').members.size, 2, 'only the sender departs');
      } finally {
        a.close();
        b.close();
        c.close();
      }
    });
  });

  await check('frame cap: a valid frame exactly at the setting is relayed', async () => {
    await withServer({ frameCapBytes: 4096 }, async (_server, url) => {
      const a = await Peer.open(url, 'exact-a');
      const b = await Peer.open(url, 'exact-b');
      try {
        await a.join({ room: 'exact-room', tabId: 'a', role: 'host' });
        await b.join({ room: 'exact-room', tabId: 'b', role: 'viewer' });
        const frame = exactFrame(4096);
        assertEqual(Buffer.byteLength(frame), 4096, 'boundary frame byte length');
        a.sendRaw(frame);
        const relayed = await b.next((env) => env.type.startsWith('x'));
        assertEqual(relayed.type.length, 4096 - JSON.stringify(buildClientEnvelope({ type: 'x', to: ADDR_ROOM, payload: {} })).length + 1, 'boundary frame relays intact');
        assert(!a.closed, 'boundary sender stays connected');
      } finally {
        a.close();
        b.close();
      }
    });
  });

  await check('frame cap: moving the setting moves both boundary assertions', async () => {
    for (const cap of [4096, 8192]) {
      await withServer({ frameCapBytes: cap }, async (_server, url) => {
        const a = await Peer.open(url, `moving-a-${cap}`);
        const b = await Peer.open(url, `moving-b-${cap}`);
        try {
          await a.join({ room: `moving-${cap}`, tabId: 'a', role: 'host' });
          await b.join({ room: `moving-${cap}`, tabId: 'b', role: 'viewer' });
          a.sendRaw(exactFrame(cap));
          await b.next((env) => env.type.startsWith('x'));
          a.sendRaw('x'.repeat(cap + 1));
          assertEqual(await a.waitClosed(), 1009, `cap ${cap} rejects cap + 1`);
        } finally {
          a.close();
          b.close();
        }
      });
    }
  });

  await check('frame cap: setting validation names the setting', async () => {
    for (const frameCapBytes of [0, 1023, 1.5, '4096']) {
      let error;
      try {
        startRoomServer({ port: 0, mediaDir, quiet: true, frameCapBytes });
      } catch (caught) {
        error = caught;
      }
      assert(error instanceof TypeError, `${frameCapBytes} is rejected`);
      assert(error.message.includes('APP_FRAME_CAP_BYTES'), `${frameCapBytes} names the frame setting`);
    }
  });
}
