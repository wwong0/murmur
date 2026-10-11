import http from 'node:http';

const finite = (value) => Number.isFinite(value);

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(value)}\n`);
}

function readBody(request) {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', () => {
      try { resolve(text ? JSON.parse(text) : {}); } catch { resolve(null); }
    });
  });
}

/** A harness-only control plane; the product server remains unchanged. */
export function startSocketControl({ roomServer, port = 8190, host = '127.0.0.1' } = {}) {
  if (!roomServer?.rooms || typeof roomServer.rooms.get !== 'function') {
    throw new TypeError('socket control requires a room server with rooms');
  }
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url?.split('?')[0] !== '/terminate') {
      json(response, 404, { error: 'not-found' });
      return;
    }
    const body = await readBody(request);
    const room = typeof body?.room === 'string' ? roomServer.rooms.get(body.room) : null;
    const tabId = typeof body?.tabId === 'string' ? body.tabId : null;
    const member = [...(room?.members?.values?.() ?? [])].find((candidate) => candidate.tabId === tabId);
    if (!member) {
      json(response, 404, { error: 'member-not-found', terminated: false });
      return;
    }
    const clientId = member.clientId;
    member.ws.terminate();
    json(response, 200, { terminated: true, clientId, atMs: Date.now() });
  });
  server.listen(port, host);
  return {
    server,
    port,
    host,
    address: () => server.address(),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export function socketControlResponseShape(value) {
  return Boolean(value && typeof value === 'object'
    && typeof value.terminated === 'boolean'
    && (!value.terminated || typeof value.clientId === 'string')
    && (!value.terminated || finite(value.atMs)));
}
