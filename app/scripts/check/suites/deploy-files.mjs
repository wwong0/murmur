import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { assert, assertEqual, check, sleep } from '../harness.mjs';
import { optionsFromEnv } from '../../../server/room-server.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEPLOY_DIR = path.join(APP_DIR, 'deploy');
const NGINX_PATH = path.join(DEPLOY_DIR, 'nginx', 'murmur.conf');
const TLS_PATH = path.join(DEPLOY_DIR, 'nginx', 'murmur-tls.conf');
const ROOM_UNIT_PATH = path.join(DEPLOY_DIR, 'systemd', 'murmur-room.service');
const TRACKER_UNIT_PATH = path.join(DEPLOY_DIR, 'systemd', 'murmur-tracker.service');
const ENV_PATH = path.join(DEPLOY_DIR, 'room.env.template');

const ACTIVE = new Map([
  ['APP_PORT', '8100'],
  ['APP_MEDIA_SOURCE', 'file'],
  ['APP_DELIVERY', 'host'],
  ['APP_TRACKER_URL', 'wss://murmurwatch.duckdns.org/tracker'],
  ['APP_ALLOWED_ORIGIN', 'https://murmurwatch.duckdns.org'],
  ['APP_TRUSTED_PROXY', '1'],
  ['APP_TURN_KEY_ID', ''],
  ['APP_TURN_API_TOKEN', ''],
]);

const COMMENTED = [
  'APP_HARNESS_COUNTERS',
  'APP_AUTO_START',
  'APP_ICE_SERVERS',
  'APP_MEDIA_DIR',
  'APP_SEGMENT_TARGET_S',
  'APP_LIVENESS_INTERVAL_MS',
  'APP_HOST_GRACE_MS',
  'APP_CHAT_BURST',
  'APP_CHAT_REFILL_MS',
  'APP_ENVELOPE_BURST',
  'APP_ENVELOPE_REFILL_MS',
  'APP_JOIN_BURST',
  'APP_JOIN_REFILL_MS',
  'APP_FRAME_CAP_BYTES',
  'APP_TURN_API_BASE',
  'APP_TURN_TTL_S',
  'APP_TURN_REUSE_MS',
];

const PATH_VARIABLE = /\$(?:request_uri|uri|args|query_string|http_referer)\b|\$request(?:\W|$)|\$arg_/;

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function parseTemplate(text) {
  const active = new Map();
  const commented = new Map();
  for (const line of text.split(/\r?\n/)) {
    const activeMatch = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    const commentedMatch = line.match(/^#([A-Z][A-Z0-9_]*)=(.*)$/);
    if (activeMatch) active.set(activeMatch[1], activeMatch[2]);
    if (commentedMatch) commented.set(commentedMatch[1], commentedMatch[2]);
  }
  return { active, commented };
}

function names(set) {
  return [...set].sort();
}

function assertSameSet(actual, expected, label) {
  const missing = names(new Set([...expected].filter((key) => !actual.has(key))));
  const unknown = names(new Set([...actual].filter((key) => !expected.has(key))));
  assert(missing.length === 0, `${label} missing ${missing.join(', ')}`);
  assert(unknown.length === 0, `${label} has unknown ${unknown.join(', ')}`);
}

function envObject(map) {
  return Object.fromEntries(map);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function statusAt(port) {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${port}/stats`, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.setTimeout(500, () => {
      request.destroy();
      resolve(null);
    });
    request.once('error', () => resolve(null));
  });
}

async function waitForStatus(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await statusAt(port);
    if (status !== null) return status;
    await sleep(50);
  }
  throw new Error(`tracker did not answer on port ${port} within 10 seconds`);
}

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([childExit(child), sleep(1000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await childExit(child);
}

export default async function deployFilesSuite() {
  await check('6.1 template names every server setting', async () => {
    const reads = [];
    const env = new Proxy({}, {
      get(target, property) {
        if (typeof property === 'string') reads.push(property);
        return Reflect.get(target, property);
      },
    });
    optionsFromEnv(env);
    const { active, commented } = parseTemplate(read(ENV_PATH));
    const declared = new Set([...active.keys(), ...commented.keys()]);
    const readSet = new Set(reads);
    assert(readSet.size > 0, 'the options probe saw no settings');
    assert(readSet.has('APP_MEDIA_SOURCE'), 'the options probe saw no APP_MEDIA_SOURCE');
    assertSameSet(declared, readSet, 'template settings');
  });

  await check('6.2 template holds no value beyond the placeholder domain', async () => {
    const { active, commented } = parseTemplate(read(ENV_PATH));
    const expected = new Set(ACTIVE.keys());
    assertSameSet(new Set(active.keys()), expected, 'active template settings');
    for (const [key, value] of ACTIVE) assertEqual(active.get(key), value, `${key} value`);
    for (const [key, value] of commented) assertEqual(value, '', `${key} commented value`);
  });

  await check('6.3 unfilled template refuses to start', async () => {
    const { active } = parseTemplate(read(ENV_PATH));
    let failure;
    try {
      optionsFromEnv(envObject(active));
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof TypeError, 'unfilled template did not throw a TypeError');
    assert(failure.message.includes('APP_TURN_KEY_ID'), 'unfilled template error names APP_TURN_KEY_ID');
  });

  await check('6.4 filled template describes the hosted instance', async () => {
    const { active } = parseTemplate(read(ENV_PATH));
    active.set('APP_TURN_KEY_ID', 'fake-key-id');
    active.set('APP_TURN_API_TOKEN', 'fake-token');
    const options = optionsFromEnv(envObject(active));
    assertEqual(options.mediaSource, 'file', 'media source');
    assertEqual(options.delivery, 'host', 'delivery');
    assertEqual(options.trustedProxy, true, 'trusted proxy');
    assertEqual(options.harnessCounters, false, 'harness counters');
    assertEqual(options.autoStart, false, 'auto start');
    assertEqual(options.port, 8100, 'port');
    assertEqual(options.allowedOrigin, 'https://murmurwatch.duckdns.org', 'allowed origin');
    assertEqual(options.trackerUrl, 'wss://murmurwatch.duckdns.org/tracker', 'tracker URL');
  });

  await check('6.5 deployment files agree', async () => {
    const nginx = read(NGINX_PATH);
    const tls = read(TLS_PATH);
    const roomUnit = read(ROOM_UNIT_PATH);
    const trackerUnit = read(TRACKER_UNIT_PATH);
    const { active } = parseTemplate(read(ENV_PATH));
    const serverNames = (text) => [...text.matchAll(/^\s*server_name\s+([^;]+);/gm)].map((match) => match[1].trim());
    const nginxNames = serverNames(nginx);
    const tlsNames = serverNames(tls);
    const host = new URL(active.get('APP_ALLOWED_ORIGIN')).hostname;
    const appPort = Number(active.get('APP_PORT'));
    const trackerPort = Number(trackerUnit.match(/--port\s+(\d+)/)[1]);
    const proxyPorts = [...tls.matchAll(/proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+);/g)].map((match) => Number(match[1]));
    const trackerPortUses = proxyPorts.filter((port) => port === trackerPort).length;
    const trackerLocation = tls.indexOf('location = /tracker');
    const trackerProxy = tls.indexOf(`proxy_pass http://127.0.0.1:${trackerPort};`);
    const certificateLines = tls.split(/\r?\n/).filter((line) => /^\s*ssl_certificate(?:_key)?\s/.test(line));
    assertEqual(nginxNames.length, 1, 'nginx application server name count');
    assertEqual(tlsNames.length, 1, 'TLS application server name count');
    assertEqual(nginxNames[0], host, 'nginx server name');
    assertEqual(tlsNames[0], host, 'TLS server name');
    assert(certificateLines.length > 0, 'TLS certificate directives exist');
    assert(certificateLines.every((line) => line.includes(host)), 'TLS certificate paths name the host');
    assert(proxyPorts.length > 0, 'proxy directives exist');
    assert(proxyPorts.every((port) => port === appPort || port === trackerPort), 'proxy ports are declared service ports');
    assertEqual(trackerPortUses, 1, 'tracker port location count');
    assert(trackerProxy > trackerLocation, 'tracker port is used by /tracker');
    assert(roomUnit.includes('EnvironmentFile=/etc/murmur/room.env'), 'room unit uses the room environment file');
  });

  await check('6.6 access logs carry no path', async () => {
    const text = `${read(NGINX_PATH)}\n${read(TLS_PATH)}`;
    const logFormats = [...text.matchAll(/^\s*log_format\s+[^;]+;/gm)].map((match) => match[0]);
    const accessLogs = [...text.matchAll(/^\s*access_log\s+[^;]+;/gm)].map((match) => match[0]);
    assert(logFormats.length > 0, 'the log-format probe saw no directive');
    assert(accessLogs.length > 0, 'the access-log probe saw no directive');
    assert(logFormats.every((line) => !PATH_VARIABLE.test(line)), 'log formats contain no request path variable');
    assert(accessLogs.every((line) => /^\s*access_log\s+off;$/.test(line) || /\smurmur_nopath;$/.test(line)), 'access logs use only approved formats');
    assert(accessLogs.some((line) => /\smurmur_nopath;$/.test(line)), 'the nopath format is used');
  });

  await check('6.7 tracker flags disable stats', async () => {
    const execLine = read(TRACKER_UNIT_PATH).split(/\r?\n/).find((line) => line.startsWith('ExecStart='));
    assert(execLine, 'tracker unit has ExecStart');
    const args = execLine.slice('ExecStart='.length).trim().split(/\s+/).slice(1);
    const portIndex = args.indexOf('--port');
    assert(portIndex >= 0 && args[portIndex + 1], 'tracker ExecStart has a port flag');
    const port = await freePort();
    const withPort = (base) => {
      const copy = [...base];
      copy[portIndex + 1] = String(port);
      return copy;
    };
    let tracker;
    let control;
    try {
      tracker = spawn(process.execPath, withPort(args), { cwd: APP_DIR, stdio: 'ignore' });
      assertEqual(await waitForStatus(port), 404, 'tracker /stats with --no-stats');
      await stopChild(tracker);
      const controlArgs = withPort(args).filter((arg) => arg !== '--no-stats');
      control = spawn(process.execPath, controlArgs, { cwd: APP_DIR, stdio: 'ignore' });
      assertEqual(await waitForStatus(port), 200, 'tracker /stats without --no-stats');
    } finally {
      await stopChild(control);
      await stopChild(tracker);
    }
  });
}
