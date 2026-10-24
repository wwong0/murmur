import { assert, assertEqual, check, Peer, sleep } from '../harness.mjs';
import { mediaDir } from '../fixtures.mjs';
import { startRoomServer } from '../../../server/room-server.mjs';
import { TYPE_ERROR } from '../../../public/lib/envelope.mjs';

const LARGE_TYPE_LENGTH = 30_000;
const SEND_COUNT = 300;

async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

function refusalEnvelope(type, id) {
  return {
    v: 1,
    type,
    to: 'server',
    id,
    payload: {},
  };
}

async function withServer(options, fn) {
  const local = startRoomServer({
    port: 0,
    mediaDir,
    quiet: true,
    livenessMs: 5000,
    envelopeBurst: 1000,
    joinBurst: 1000,
    sendBufferBytes: 65_536,
    ...options,
  });
  try {
    return await fn(local, `ws://127.0.0.1:${await local.ready}/ws`);
  } finally {
    await local.close();
  }
}

export default async function sendBufferSuite() {
  await check('send buffer: a non-reading client is terminated while a reader remains open', async () => {
    await withServer({}, async (local, url) => {
      const silent = await Peer.open(url, 'silent-buffer');
      const reader = await Peer.open(url, 'reading-buffer');
      try {
        const beforeSilent = local.wss.clients.size;
        silent.goSilent();
        const silentType = `silent-${'x'.repeat(LARGE_TYPE_LENGTH - 7)}`;
        for (let i = 0; i < SEND_COUNT; i++) {
          try {
            silent.send(refusalEnvelope(silentType, `silent-${i}`));
          } catch {
            break;
          }
        }
        await waitFor(() => local.wss.clients.size === beforeSilent - 1, 'silent client termination');
        assert(silent.closed || local.wss.clients.size === beforeSilent - 1, 'silent client is no longer in the server');

        const readerType = 'reader';
        for (let i = 0; i < SEND_COUNT; i++) reader.send(refusalEnvelope(readerType, `reader-${i}`));
        const refusal = await reader.next((env) => env.type === TYPE_ERROR);
        assert(refusal.payload.detail.includes(readerType), 'reader refusal quotes the type');
        await sleep(150);
        assert(!reader.closed, 'reading client remains open');
      } finally {
        silent.close();
        reader.close();
      }
    });
  });

  await check('send buffer: the option is positive and independent of the frame cap', async () => {
    let error;
    try {
      startRoomServer({ port: 0, mediaDir, quiet: true, sendBufferBytes: 0 });
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof TypeError, 'zero send buffer is refused');
    assert(error.message.includes('sendBufferBytes'), 'send buffer refusal names the option');
    await withServer({ frameCapBytes: 4096 }, async (local) => {
      assertEqual(local.sendBufferBytes, 65_536, 'configured send buffer');
      assert(local.frameCapBytes < local.sendBufferBytes, 'send buffer is independent of frame cap');
    });
  });
}
