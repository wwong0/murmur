import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { assert, assertEqual, check, sleep } from '../harness.mjs';
import { optionsFromEnv } from '../../../server/room-server.mjs';
import { stopChild, unusedPort } from '../../runner/local-processes.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEPLOY_DIR = path.join(APP_DIR, 'deploy');
const NGINX_PATH = path.join(DEPLOY_DIR, 'nginx', 'murmur.conf');
const TLS_PATH = path.join(DEPLOY_DIR, 'nginx', 'murmur-tls.conf');
const ROOM_UNIT_PATH = path.join(DEPLOY_DIR, 'systemd', 'murmur-room.service');
const TRACKER_UNIT_PATH = path.join(DEPLOY_DIR, 'systemd', 'murmur-tracker.service');
const ENV_PATH = path.join(DEPLOY_DIR, 'room.env.template');

const HOST = 'murmurwatch.duckdns.org';

const ACTIVE = new Map([
  ['APP_PORT', '8100'],
  ['APP_MEDIA_SOURCE', 'file'],
  ['APP_DELIVERY', 'host'],
  ['APP_TRACKER_URL', `wss://${HOST}/tracker`],
  ['APP_ALLOWED_ORIGIN', `https://${HOST}`],
  ['APP_TRUSTED_PROXY', '1'],
  ['APP_TURN_KEY_ID', ''],
  ['APP_TURN_API_TOKEN', ''],
]);

// An allowlist: a denylist of path variables misses aliases such as $document_uri (13-2 F2).
const LOG_VARIABLES = new Set([
  '$time_iso8601',
  '$remote_addr',
  '$request_method',
  '$status',
  '$body_bytes_sent',
  '$request_time',
]);

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function parseTemplate(text) {
  const active = new Map();
  const commented = new Map();
  for (const [, hash, key, value] of text.matchAll(/^(#?)([A-Z][A-Z0-9_]*)=(.*?)\r?$/gm)) {
    (hash ? commented : active).set(key, value);
  }
  return { active, commented };
}

function assertSameSet(actual, expected, label) {
  const missing = [...expected].filter((key) => !actual.has(key)).sort();
  const unknown = [...actual].filter((key) => !expected.has(key)).sort();
  assert(missing.length === 0, `${label} missing ${missing.join(', ')}`);
  assert(unknown.length === 0, `${label} has unknown ${unknown.join(', ')}`);
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

/** Starts the tracker with these arguments, reads its /stats status, and stops it. */
async function statsStatus(args, port) {
  const tracker = spawn(process.execPath, args, { cwd: APP_DIR, stdio: 'ignore' });
  try {
    return await waitForStatus(port);
  } finally {
    await stopChild(tracker);
  }
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
      optionsFromEnv(Object.fromEntries(active));
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
    const options = optionsFromEnv(Object.fromEntries(active));
    assertEqual(options.mediaSource, 'file', 'media source');
    assertEqual(options.delivery, 'host', 'delivery');
    assertEqual(options.trustedProxy, true, 'trusted proxy');
    assertEqual(options.harnessCounters, false, 'harness counters');
    assertEqual(options.autoStart, false, 'auto start');
    assertEqual(options.port, 8100, 'port');
    assertEqual(options.allowedOrigin, `https://${HOST}`, 'allowed origin');
    assertEqual(options.trackerUrl, `wss://${HOST}/tracker`, 'tracker URL');
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
    // Each location's text runs to the next location, so a proxy_pass is read where it sits.
    const locationPorts = tls.split(/^\s*location\s+/m).slice(1).map((block) => {
      const ports = [...block.matchAll(/proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+);/g)].map((match) => Number(match[1]));
      return [block.match(/^(?:=\s*)?(\S+)/)[1], ports];
    });
    const certificateLines = tls.split(/\r?\n/).filter((line) => /^\s*ssl_certificate(?:_key)?\s/.test(line));
    assertEqual(nginxNames.length, 1, 'nginx application server name count');
    assertEqual(tlsNames.length, 1, 'TLS application server name count');
    assertEqual(nginxNames[0], host, 'nginx server name');
    assertEqual(tlsNames[0], host, 'TLS server name');
    assert(certificateLines.length > 0, 'TLS certificate directives exist');
    assert(certificateLines.every((line) => line.includes(host)), 'TLS certificate paths name the host');
    assertEqual(
      JSON.stringify(locationPorts),
      JSON.stringify([['/ws', [appPort]], ['/tracker', [trackerPort]], ['/', [appPort]]]),
      'each location proxies to its service port',
    );
    assert(roomUnit.includes('EnvironmentFile=/etc/murmur/room.env'), 'room unit uses the room environment file');
  });

  await check('6.6 access logs carry no path', async () => {
    const text = `${read(NGINX_PATH)}\n${read(TLS_PATH)}`;
    const logFormats = [...text.matchAll(/^\s*log_format\s+[^;]+;/gm)].map((match) => match[0]);
    const accessLogs = [...text.matchAll(/^\s*access_log\s+[^;]+;/gm)].map((match) => match[0]);
    assert(logFormats.length > 0, 'the log-format probe saw no directive');
    assert(accessLogs.length > 0, 'the access-log probe saw no directive');
    const variables = logFormats.flatMap((line) => line.match(/\$\w+/g) ?? []);
    assert(variables.length > 0, 'the log-format probe saw no variable');
    const unlisted = variables.filter((variable) => !LOG_VARIABLES.has(variable));
    assert(unlisted.length === 0, `log formats use unlisted variables ${unlisted.join(', ')}`);
    assert(accessLogs.every((line) => /^\s*access_log\s+off;$/.test(line) || /\smurmur_nopath;$/.test(line)), 'access logs use only approved formats');
    assert(accessLogs.some((line) => /\smurmur_nopath;$/.test(line)), 'the nopath format is used');
  });

  await check('6.7 tracker flags disable stats', async () => {
    const execLine = read(TRACKER_UNIT_PATH).split(/\r?\n/).find((line) => line.startsWith('ExecStart='));
    assert(execLine, 'tracker unit has ExecStart');
    const args = execLine.slice('ExecStart='.length).trim().split(/\s+/).slice(1);
    const portIndex = args.indexOf('--port');
    assert(portIndex >= 0 && args[portIndex + 1], 'tracker ExecStart has a port flag');
    const port = await unusedPort();
    args[portIndex + 1] = String(port);
    assertEqual(await statsStatus(args, port), 404, 'tracker /stats with --no-stats');
    const control = args.filter((arg) => arg !== '--no-stats');
    assertEqual(await statsStatus(control, port), 200, 'tracker /stats without --no-stats');
  });
}
