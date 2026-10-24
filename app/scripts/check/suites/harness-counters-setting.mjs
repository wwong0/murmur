import { assert, assertEqual, check, sleep } from '../harness.mjs';
import { mediaDir } from '../fixtures.mjs';
import { optionsFromEnv, startRoomServer } from '../../../server/room-server.mjs';

async function withServer(options, fn) {
  const server = startRoomServer({ port: 0, mediaDir, quiet: true, ...options });
  try {
    const port = await server.ready;
    return await fn(server, `http://127.0.0.1:${port}`);
  } finally {
    await server.close();
  }
}

async function readBody(response) {
  return Buffer.from(await response.arrayBuffer());
}

export default async function harnessCountersSettingSuite() {
  await check('harness counters: default off skips records and the snapshot route', async () => {
    await withServer({}, async (server, origin) => {
      const snapshot = await fetch(`${origin}/harness/counters`);
      assertEqual(snapshot.status, 404, 'disabled snapshot route falls through to static files');
      const body = await snapshot.text();
      assert(!body.includes('counters'), 'disabled snapshot body has no counter field');

      await readBody(await fetch(`${origin}/`));
      await readBody(await fetch(`${origin}/room.bundle.js`));
      const media = await fetch(`${origin}/media/master.m3u8`);
      assertEqual(media.status, 200, 'disabled server still serves media');
      await readBody(media);
      assertEqual(server.counters, null, 'disabled server exposes no counters object');
    });
  });

  await check('harness counters: enabled media response records delivered bytes', async () => {
    await withServer({ harnessCounters: true }, async (server, origin) => {
      const response = await fetch(`${origin}/media/seg-00000.m4s`);
      const body = await readBody(response);
      assertEqual(response.status, 200, 'enabled media status');
      const deadline = Date.now() + 3000;
      let snapshot;
      do {
        snapshot = server.counters.snapshot();
        if (snapshot.byPath['/media/seg-00000.m4s']?.completedHits === 1) break;
        await sleep(5);
      } while (Date.now() < deadline);
      assertEqual(snapshot.byPath['/media/seg-00000.m4s']?.completedHits, 1, 'enabled response is recorded');
      assertEqual(snapshot.byPath['/media/seg-00000.m4s'].bytesDelivered, body.byteLength, 'recorded bytes match delivery');
    });
  });

  await check('harness counters: invalid environment value names the setting', async () => {
    let error = null;
    try {
      optionsFromEnv({ APP_HARNESS_COUNTERS: 'yes' });
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof TypeError, 'invalid harness counters value throws TypeError');
    assert(error.message.includes('APP_HARNESS_COUNTERS'), 'invalid harness counters value names the setting');
  });
}
