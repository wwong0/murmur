// The origin container's process: the existing room server, bound where other
// containers can reach it.
//
// `room-server.mjs` defaults to 127.0.0.1, which inside a container accepts
// nothing from the client containers; the host is an option it already takes.

import { startRoomServer } from '../server/room-server.mjs';

const server = startRoomServer({
  host: process.env.APP_HOST ?? '0.0.0.0',
  port: process.env.APP_PORT ? Number(process.env.APP_PORT) : undefined,
  mediaDir: process.env.APP_MEDIA_DIR,
  livenessMs: process.env.APP_LIVENESS_INTERVAL_MS ? Number(process.env.APP_LIVENESS_INTERVAL_MS) : undefined,
});

server.ready.then((port) => console.log(`[origin] ready on ${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[origin] ${signal} received, closing`);
    server.close().then(() => process.exit(0));
  });
}
