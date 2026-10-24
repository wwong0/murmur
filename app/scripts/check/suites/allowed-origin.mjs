import net from 'node:net';

import { assert, assertEqual, check, Peer } from '../harness.mjs';
import { mediaDir } from '../fixtures.mjs';
import { startRoomServer } from '../../../server/room-server.mjs';

function refusedUpgrade(port, origin) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`
      );
    });
    let raw = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(raw ? Number(raw.slice(9, 12)) : 0);
    };
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => {
      raw += chunk;
      if (raw.includes('\r\n\r\n')) finish();
    });
    socket.on('close', () => finish());
    socket.on('error', () => finish());
  });
}

async function withServer(fn) {
  const local = startRoomServer({ port: 0, mediaDir, quiet: true, allowedOrigin: 'https://room.example.test', envelopeBurst: 1000 });
  try {
    return await fn(local, `ws://127.0.0.1:${await local.ready}/ws`);
  } finally {
    await local.close();
  }
}

export default async function allowedOriginSuite() {
  await check('allowed origin: a foreign origin is refused before a websocket opens', async () => {
    await withServer(async (local) => {
      const before = local.rooms.size;
      const status = await refusedUpgrade(await local.ready, 'https://foreign.example.test');
      assertEqual(status, 403, 'foreign origin status');
      assertEqual(local.wss.clients.size, 0, 'foreign origin opens no socket');
      assertEqual(local.rooms.size, before, 'foreign origin changes no room');
    });
  });

  await check('allowed origin: a non-browser upgrade without Origin is accepted', async () => {
    await withServer(async (_local, url) => {
      const peer = await Peer.open(url, 'origin-absent');
      try {
        assertEqual((await peer.join({ room: 'origin-absent', tabId: 'a', role: 'viewer' })).type, 'joined', 'absent Origin joins');
      } finally {
        peer.close();
      }
    });
  });

  await check('allowed origin: the configured Origin is accepted', async () => {
    await withServer(async (_local, url) => {
      const peer = await Peer.open(url, 'origin-match', { headers: { Origin: 'https://room.example.test' } });
      try {
        assertEqual((await peer.join({ room: 'origin-match', tabId: 'a', role: 'viewer' })).type, 'joined', 'matching Origin joins');
      } finally {
        peer.close();
      }
    });
  });

  await check('allowed origin: the environment option validates as an exact origin', async () => {
    const { optionsFromEnv } = await import('../../../server/room-server.mjs');
    assertEqual(optionsFromEnv({ APP_ALLOWED_ORIGIN: 'https://room.example.test' }).allowedOrigin, 'https://room.example.test', 'origin option');
    for (const value of ['room.example.test', 'https://room.example.test/path', '']) {
      let error;
      try { optionsFromEnv({ APP_ALLOWED_ORIGIN: value }); } catch (caught) { error = caught; }
      assert(error instanceof TypeError, `${value || 'empty'} origin is rejected`);
      assert(error.message.includes('APP_ALLOWED_ORIGIN'), `${value || 'empty'} names the setting`);
    }
  });
}
