// A TCP relay in front of Chrome's DevTools port, because Chrome will not put
// that port anywhere the host can reach.
//
// Chrome 153 IGNORES `--remote-debugging-address=0.0.0.0` — measured inside the
// client container, `ss -ltn` shows `127.0.0.1:9222` with the flag set — so a
// published container port forwards to an address nothing is listening on and
// the driver on the host sees "client never exposed CDP". Chrome therefore
// listens on loopback only and this relay is what binds the published port.
//
// Node rather than socat: the client image gets no extra package for this, and
// the agent process is already there. DevTools' own Host-header check is not in
// the way — it accepts the `127.0.0.1:<published>` a forwarded request carries.

import net from 'node:net';

const DEFAULT_ERROR_LIMIT = 8;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createCdpRelay({
  host = '0.0.0.0',
  port = 9222,
  upstreamHost = '127.0.0.1',
  upstreamPort = 9333,
  errorLimit = DEFAULT_ERROR_LIMIT,
} = {}) {
  const sockets = new Set();
  const state = { listening: false, port, upstreamPort, connections: 0, errors: [] };
  const server = net.createServer((client) => {
    sockets.add(client);
    state.connections = sockets.size;
    const upstream = net.connect({ host: upstreamHost, port: upstreamPort });
    let closed = false;

    const recordError = (side, error) => {
      state.errors.push(`${side}: ${errorText(error)}`);
      if (state.errors.length > errorLimit) state.errors.splice(0, state.errors.length - errorLimit);
    };
    const closePair = () => {
      if (closed) return;
      closed = true;
      sockets.delete(client);
      state.connections = sockets.size;
      client.destroy();
      upstream.destroy();
    };

    client.on('error', (error) => {
      recordError('client', error);
      closePair();
    });
    upstream.on('error', (error) => {
      recordError('upstream', error);
      closePair();
    });
    client.on('end', closePair);
    upstream.on('end', closePair);
    client.on('close', closePair);
    upstream.on('close', closePair);
    client.pipe(upstream);
    upstream.pipe(client);
  });

  async function listen() {
    await new Promise((resolve, reject) => {
      const onListening = () => {
        server.off('error', onError);
        state.listening = true;
        state.port = server.address().port;
        server.on('error', (error) => {
          state.errors.push(`listener: ${errorText(error)}`);
          if (state.errors.length > errorLimit) state.errors.splice(0, state.errors.length - errorLimit);
        });
        resolve();
      };
      const onError = (error) => {
        server.off('listening', onListening);
        state.errors.push(`listener: ${errorText(error)}`);
        if (state.errors.length > errorLimit) state.errors.splice(0, state.errors.length - errorLimit);
        reject(error);
      };
      server.once('listening', onListening);
      server.once('error', onError);
      server.listen(port, host);
    });
  }

  async function close() {
    for (const socket of [...sockets]) socket.destroy();
    if (state.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
      state.listening = false;
    }
    state.connections = sockets.size;
    return status();
  }

  function status() {
    return { ...state, errors: [...state.errors] };
  }

  return { listen, close, status };
}
