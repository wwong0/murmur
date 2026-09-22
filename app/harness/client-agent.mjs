// A client container's process: one headless Chrome, and a small control API
// the driver on the host uses to end it and to read what happened.
//
// Why an agent rather than `docker exec google-chrome`: the disposal is the
// path that orphans a profile, and `linuxChrome.dispose` REPORTS what it did —
// signalled, exited, killed, profileRemoved (runner/browser-platform.mjs). A
// report only exists if something in the container held the child handle, so
// the launcher lives here and the driver reads its answer over HTTP. The
// qualification case that kills Chrome out from under the driver
// (executor-spec.md §11.2) is exactly the case where that report is the
// evidence.
//
// The control API is on `wa-control`, so ending a browser and reading its
// version are never shaped by a qdisc attached to the media interface.

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createCdpRelay } from './cdp-relay.mjs';
import { FLAGS } from '../scripts/cdp.mjs';
import { selectBrowserPlatform } from '../scripts/runner/browser-platform.mjs';

const CDP_PORT = Number(process.env.APP_CDP_PORT ?? 9222);
const CDP_UPSTREAM_PORT = 9333;
const CONTROL_PORT = Number(process.env.APP_AGENT_PORT ?? 9223);
const WINDOW_SIZE = process.env.APP_WINDOW_SIZE ?? '1280,720';
const TAG = process.env.APP_TAG ?? 'client';

// Part of the regime, so every one of them is reported to the manifest rather
// than only passed to the process (executor-spec.md §3.3). `--no-sandbox`
// because the container is the sandbox; the alternative, `--cap-add=SYS_ADMIN`,
// is wider. Shared memory is sized in compose (`shm_size`) instead of moved
// with `--disable-dev-shm-usage`, because the flag changes where Chrome puts
// it and the size does not.
const CONTAINER_FLAGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  `--remote-debugging-port=${CDP_UPSTREAM_PORT}`,
  `--window-size=${WINDOW_SIZE}`,
];

const platform = selectBrowserPlatform();

function chromeVersion() {
  try {
    return execFileSync(platform.locate(), ['--version'], { encoding: 'utf8' }).trim();
  } catch (error) {
    return `unavailable: ${error.message}`;
  }
}

function interfaces() {
  try {
    return JSON.parse(execFileSync('ip', ['-json', '-4', 'addr', 'show'], { encoding: 'utf8' }))
      .map((entry) => ({
        ifName: entry.ifname,
        addresses: (entry.addr_info ?? []).map((info) => `${info.local}/${info.prefixlen}`),
      }));
  } catch (error) {
    return [{ ifName: null, error: error.message }];
  }
}

const state = {
  tag: TAG,
  profile: path.join(os.tmpdir(), `chrome-profile-${crypto.randomUUID()}`),
  child: null,
  launchedAt: null,
  disposal: null,
  chromeVersion: chromeVersion(),
  flags: [...FLAGS, ...CONTAINER_FLAGS],
  echo: null,
  cdpRelay: createCdpRelay({ port: CDP_PORT, upstreamPort: CDP_UPSTREAM_PORT }),
};

function launch() {
  fs.mkdirSync(state.profile, { recursive: true });
  const args = [...state.flags, `--user-data-dir=${state.profile}`, 'about:blank'];
  state.child = platform.launch(args, { stdio: ['ignore', 'pipe', 'pipe'] });
  state.launchedAt = new Date().toISOString();
  state.child.stderr?.on('data', (chunk) => process.stderr.write(`[${TAG}/chrome] ${chunk}`));
  state.child.on('exit', (code, signal) => console.log(`[${TAG}/chrome] exit code=${code} signal=${signal}`));
}

function running() {
  return Boolean(state.child && state.child.exitCode === null && state.child.signalCode === null);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const finish = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function pageTargets() {
  const response = await fetch(`http://127.0.0.1:${CDP_UPSTREAM_PORT}/json/list`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`/json/list answered HTTP ${response.status}`);
  return (await response.json()).filter((target) => target.type === 'page');
}

/**
 * Ready means A PAGE TARGET EXISTS, not that the port is bound.
 *
 * Chrome binds its debugger port well before it finishes first-run profile
 * setup and has an `about:blank` to attach to, and the driver's readiness
 * signal is this agent answering `/status`. A bare TCP connect therefore
 * reported ready into a window where `attach` could still exhaust its whole
 * retry budget and fail with "window never appeared" — observed on a cold
 * container starting two clients at once.
 */
async function waitForChrome() {
  let lastError = null;
  for (let attempt = 0; attempt < 240; attempt++) {
    if (await canConnect(CDP_UPSTREAM_PORT)) {
      try {
        if ((await pageTargets()).length > 0) return;
        lastError = new Error('CDP is up but has no page target yet');
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chrome CDP never offered a page target on ${CDP_UPSTREAM_PORT}: ${lastError?.message ?? 'port never accepted'}`);
}

function readBody(request) {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function startEcho(body) {
  stopEcho();
  const args = [
    path.join('/app', 'harness', 'echo-probe.mjs'),
    `--origin=${body.originUrl ?? process.env.APP_ORIGIN}`,
    `--room=${body.room}`,
    `--tab=${body.tag ?? TAG}`,
    `--out=${body.out}`,
    `--interval-ms=${body.intervalMs ?? 250}`,
  ];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  child.stderr?.on('data', (chunk) => process.stderr.write(`[${TAG}/echo] ${chunk}`));
  state.echo = { pid: child.pid, args, child, startedAt: new Date().toISOString() };
  return { pid: child.pid, args };
}

function stopEcho() {
  if (!state.echo?.child) return { stopped: false };
  try {
    state.echo.child.kill('SIGTERM');
  } catch {}
  const record = { stopped: true, pid: state.echo.pid, startedAt: state.echo.startedAt };
  state.echo = null;
  return record;
}

let disposalPromise;

async function dispose() {
  if (disposalPromise) return disposalPromise;
  disposalPromise = (async () => {
    stopEcho();
    let relay;
    try {
      relay = await state.cdpRelay.close();
      relay.closed = !relay.listening;
    } catch (error) {
      relay = { ...state.cdpRelay.status(), closed: false, error: error.message };
    }
    const chrome = await platform.dispose(state.child, state.profile);
    state.disposal = { ...chrome, relay };
    state.disposal.profileExists = fs.existsSync(state.profile);
    return state.disposal;
  })();
  return disposalPromise;
}

const routes = {
  async 'GET /status'() {
    return {
      tag: state.tag,
      chromeVersion: state.chromeVersion,
      flags: state.flags,
      profile: state.profile,
      pid: state.child?.pid ?? null,
      running: running(),
      launchedAt: state.launchedAt,
      disposal: state.disposal,
      cdpPort: CDP_PORT,
      cdpRelay: state.cdpRelay.status(),
      interfaces: interfaces(),
      echo: state.echo ? { pid: state.echo.pid, startedAt: state.echo.startedAt } : null,
    };
  },
  async 'POST /dispose'() {
    return dispose();
  },
  async 'POST /echo/start'(body) {
    return startEcho(body);
  },
  async 'POST /echo/stop'() {
    return stopEcho();
  },
};

const controlServer = http.createServer(async (request, response) => {
  const key = `${request.method} ${request.url.split('?')[0]}`;
  const route = routes[key];
  if (!route) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: `no route for ${key}` }));
    return;
  }
  try {
    const body = request.method === 'POST' ? await readBody(request) : {};
    const value = await route(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(`${JSON.stringify(value)}\n`);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: error.message, stack: error.stack }));
  }
});

async function start() {
  launch();
  await waitForChrome();
  await state.cdpRelay.listen();
  console.log(`[${TAG}] cdp relay listening on ${CDP_PORT} -> ${CDP_UPSTREAM_PORT}`);
  controlServer.listen(CONTROL_PORT, '0.0.0.0', () => console.log(`[${TAG}] agent on ${CONTROL_PORT}, cdp on ${CDP_PORT}`));
}

start().catch(async (error) => {
  console.error(`[${TAG}] startup failed: ${error.message}`);
  await dispose();
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await dispose();
    process.exit(0);
  });
}
