import http from 'node:http';

import { assert, assertEqual, check, sleep } from '../harness.mjs';
import { mediaDir } from '../fixtures.mjs';
import { optionsFromEnv, startRoomServer } from '../../../server/room-server.mjs';
import { createRelayCredentials } from '../../../server/relay-credentials.mjs';

const STUN = { urls: 'stun:stun.example.test' };
const TURN = { urls: ['turn:configured.example.test', 'stun:stun.example.test'], username: 'configured-user', credential: 'configured-secret' };

function fakeService({ status = 200, delayMs = 0, body = () => ({ iceServers: [{ urls: 'turn:minted.example.test', username: 'minted-user', credential: 'minted-secret' }] }) } = {}) {
  let calls = 0;
  const server = http.createServer(async (_req, res) => {
    calls += 1;
    if (delayMs) await sleep(delayMs);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(typeof body === 'function' ? body(calls) : body));
  });
  return {
    server,
    async open() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}/v1`;
    },
    get calls() { return calls; },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

function response(status, body) {
  return { status, async json() { return body; } };
}

export default async function relayCredentialsSuite() {
  await check('relay credentials: concurrent settings requests share one minted credential', async () => {
    const fake = fakeService();
    const apiBase = await fake.open();
    try {
      let now = 1000;
      const relay = createRelayCredentials({ keyId: 'key-id', token: 'secret-token', apiBase, ttlS: 60, reuseMs: 150, now: () => now, fetch: globalThis.fetch });
      const [first, second] = await Promise.all([relay.iceServers([STUN, TURN]), relay.iceServers([STUN, TURN])]);
      assertEqual(fake.calls, 1, 'one request in the reuse window');
      assertEqual(JSON.stringify(first), JSON.stringify(second), 'shared request returns the same credential');
      assertEqual(JSON.stringify(first), JSON.stringify([STUN, { urls: 'turn:minted.example.test', username: 'minted-user', credential: 'minted-secret' }]), 'configured TURN is replaced');
      assert(!JSON.stringify(first).includes('secret-token'), 'API token is absent from the response body');
      now += 150;
      const third = await relay.iceServers([STUN, TURN]);
      assertEqual(fake.calls, 2, 'the exact reuse boundary mints again');
      assert(third[1].credential === 'minted-secret', 'the refreshed credential is served');
    } finally {
      await fake.close();
    }
  });

  await check('relay credentials: a singleton response entry is accepted and non-TURN entries stay first', async () => {
    const fake = fakeService({ body: { iceServers: { urls: 'turn:single.example.test', username: 'u', credential: 'c' } } });
    const apiBase = await fake.open();
    try {
      const relay = createRelayCredentials({ keyId: 'k', token: 't', apiBase, ttlS: 60, reuseMs: 1000 });
      assertEqual(JSON.stringify(await relay.iceServers([STUN, TURN])), JSON.stringify([STUN, { urls: 'turn:single.example.test', username: 'u', credential: 'c' }]), 'singleton response shape');
    } finally {
      await fake.close();
    }
  });

  await check('relay credentials: HTTP failure falls back and the next request retries', async () => {
    const fake = fakeService({ status: 500, body: { error: 'secret-token and minted-secret must not leak' } });
    const apiBase = await fake.open();
    const logs = [];
    try {
      const relay = createRelayCredentials({ keyId: 'key-id', token: 'secret-token', apiBase, ttlS: 60, reuseMs: 1000, log: (line) => logs.push(line) });
      const configured = [STUN, TURN];
      assertEqual(JSON.stringify(await relay.iceServers(configured)), JSON.stringify([STUN]), 'HTTP failure serves configured non-TURN entries');
      assertEqual(JSON.stringify(await relay.iceServers(configured)), JSON.stringify([STUN]), 'failure is not cached');
      assertEqual(fake.calls, 2, 'failure retries on the next request');
      assertEqual(logs.length, 2, 'each failure is logged');
      assert(logs.every((line) => line === 'relay credential request failed: HTTP 500'), 'failure log contains only status');
      assert(logs.every((line) => !line.includes('secret-token') && !line.includes('minted-secret')), 'failure logs contain no secret');
    } finally {
      await fake.close();
    }
  });

  await check('relay credentials: timeout falls back and retries', async () => {
    const fake = fakeService({ delayMs: 100 });
    const apiBase = await fake.open();
    let calls = 0;
    try {
      const relay = createRelayCredentials({ keyId: 'k', token: 't', apiBase, ttlS: 60, reuseMs: 1000, timeoutMs: 20, log: () => {} });
      assertEqual(JSON.stringify(await relay.iceServers([STUN])), JSON.stringify([STUN]), 'timeout serves non-TURN entries');
      assertEqual(JSON.stringify(await relay.iceServers([STUN])), JSON.stringify([STUN]), 'timeout is not cached');
      calls = fake.calls;
      assertEqual(calls, 2, 'timeout retries');
    } finally {
      await fake.close();
    }
  });

  await check('relay credentials: app-settings is lazy, cached and never calls without a token', async () => {
    let calls = 0;
    const configured = [STUN, TURN];
    const local = startRoomServer({
      port: 0,
      mediaDir,
      quiet: true,
      iceServers: configured,
      turnKeyId: 'key-id',
      turnApiToken: 'secret-token',
      turnApiBase: 'http://relay.invalid/v1',
      turnTtlS: 60,
      turnReuseMs: 1000,
      fetch: async () => {
        calls += 1;
        return response(200, { iceServers: [{ urls: 'turn:minted.example.test', username: 'u', credential: 'minted-secret' }] });
      },
    });
    try {
      const origin = `http://127.0.0.1:${await local.ready}`;
      assertEqual(calls, 0, 'credential minting is lazy');
      const first = await (await fetch(`${origin}/app-settings`)).json();
      const second = await (await fetch(`${origin}/app-settings`)).json();
      assertEqual(calls, 1, 'settings requests share a cached credential');
      assertEqual(JSON.stringify(first.iceServers), JSON.stringify(second.iceServers), 'cached settings match');
    } finally {
      await local.close();
    }

    let noTokenCalls = 0;
    const noToken = startRoomServer({ port: 0, mediaDir, quiet: true, iceServers: configured, fetch: async () => { noTokenCalls += 1; } });
    try {
      const body = await (await fetch(`http://127.0.0.1:${await noToken.ready}/app-settings`)).json();
      assertEqual(JSON.stringify(body.iceServers), JSON.stringify(configured), 'without a token configured ICE is unchanged');
      assertEqual(noTokenCalls, 0, 'without a token fake relay is unused');
    } finally {
      await noToken.close();
    }
  });

  await check('relay credentials: startup settings validate as a pair and bounded values', async () => {
    assertEqual(optionsFromEnv({}).turnApiBase, 'https://rtc.live.cloudflare.com/v1', 'default API base');
    assertEqual(optionsFromEnv({}).turnTtlS, 43_200, 'default TTL');
    assertEqual(optionsFromEnv({}).turnReuseMs, 60_000, 'default reuse window');
    for (const env of [
      { APP_TURN_KEY_ID: 'key' },
      { APP_TURN_API_TOKEN: 'token' },
      { APP_TURN_TTL_S: '59' },
      { APP_TURN_TTL_S: '172801' },
      { APP_TURN_REUSE_MS: '0' },
      { APP_TURN_API_BASE: 'ws://relay.test/v1' },
    ]) {
      let error;
      try { optionsFromEnv(env); } catch (caught) { error = caught; }
      assert(error instanceof TypeError, `${JSON.stringify(env)} is rejected`);
    }
  });
}
