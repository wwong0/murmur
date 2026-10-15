// The compose topology the run driver talks to: bring the containers up,
// resolve the media interface, start the in-container samplers, hand the driver
// one CDP tab per client, and take it all down again.
//
// The driver runs on the host and the clients run in containers, so there are
// two origin URLs and they are not interchangeable. `originUrl` is the
// published port this process fetches counters and health over; `clientOriginUrl`
// is the name the browsers resolve on the media network. Giving a browser the
// host URL would put every media byte through the port forwarder instead of the
// shaped interface (design.md D1).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach } from '../cdp.mjs';
import {
  applyQdiscs, asyncExec, changeQdisc, clearCondition, defaultExec, dockerExec, networkSubnet, resolveInterface, resolveInterfaceAsync,
} from '../../harness/apply-qdisc.mjs';
import { requireDelivery } from '../delivery-pin.mjs';
import { armFor } from './arms.mjs';
import { hostSourceOnLoopback, topologyReadback } from './topology-readback.mjs';

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'harness');
const COMPOSE_FILE = path.join(HARNESS_DIR, 'compose.yaml');
const APP_DIR = path.resolve(HARNESS_DIR, '..');
const LEGACY_CONTENT_IDENTITY = 'step0-content-media-v1';
const LEGACY_CONTENT = Object.freeze({ segmentSeconds: 4, segmentCount: 1_800, totalBytes: 2_365_859_777 });

export const PROJECT = 'wa6a';
export const MEDIA_NETWORK = 'wa-media';
export const CONTROL_NETWORK = 'wa-control';
export const ORIGIN_HOST_URL = 'http://127.0.0.1:8110';
export const SERVER_HOST_URL = 'http://127.0.0.1:8111';
// The MEDIA alias, never the bare service name: `origin` resolves to both of
// the origin's addresses and a client that picked the control one would fetch
// its media past the shaped interface (compose.yaml).
export const CLIENT_ORIGIN_URL = 'http://origin-media:8100';
export const SERVER_CLIENT_URL = 'http://server-media:8100';
export const HOST_PAGE_URL = 'http://127.0.0.1:8100';

export function urlsForDelivery(delivery) {
  if (delivery === 'host') return {
    countersUrl: SERVER_HOST_URL,
    clientOriginUrl: SERVER_CLIENT_URL,
    hostPageUrl: HOST_PAGE_URL,
  };
  if (delivery === 'http') return {
    countersUrl: ORIGIN_HOST_URL,
    clientOriginUrl: CLIENT_ORIGIN_URL,
    hostPageUrl: ORIGIN_HOST_URL,
  };
  throw new Error(`unsupported delivery: ${delivery}`);
}

const CDP_PORT_BASE = 9300;
const AGENT_PORT_BASE = 9400;

export const cdpPortFor = (tag) => CDP_PORT_BASE + Number(String(tag).replace(/\D/g, ''));
export const agentPortFor = (tag) => AGENT_PORT_BASE + Number(String(tag).replace(/\D/g, ''));

export function compose(args, { project = PROJECT, exec = defaultExec } = {}) {
  return exec(['docker', 'compose', '-p', project, '-f', COMPOSE_FILE, ...args]);
}

/** Service name to running container name, from compose rather than a naming convention. */
export function composeContainers(project = PROJECT, exec = defaultExec) {
  const text = compose(['ps', '--format', 'json'], { project, exec }).trim();
  const rows = text ? text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  return Object.fromEntries(rows.map((row) => [row.Service, row.Name]));
}

export function readTopology({ containers, exec = defaultExec } = {}) {
  const names = Object.keys(containers ?? {});
  const raw = { containers: {} };
  for (const name of names) {
    const container = containers[name];
    const addresses = dockerExec(container, ['ip', '-json', 'addr', 'show'], exec);
    const interfaces = JSON.parse(addresses).map((entry) => entry.ifname).filter(Boolean);
    const qdiscs = Object.fromEntries(interfaces.map((ifName) => [ifName,
      dockerExec(container, ['tc', 'qdisc', 'show', 'dev', ifName], exec)]));
    raw.containers[name] = {
      container,
      addresses,
      qdiscs,
      established: dockerExec(container, ['ss', '-Htn', 'state', 'established'], exec),
      ...(name === 'origin' ? { listeners: dockerExec(container, ['ss', '-Htln'], exec) } : {}),
    };
  }
  return raw;
}

const MEDIA_COUNTERS_SCRIPT = "fetch('http://127.0.0.1:8102/harness/counters').then(async (response) => { if (!response.ok) throw new Error('HTTP ' + response.status); process.stdout.write(await response.text()); })";

// The boundary's forms: one `docker exec` at a time, each awaited, so the poll
// loops keep running through a read-back (9b design.md D1, J16).
export async function readTopologyAsync({ containers, exec = asyncExec } = {}) {
  const raw = { containers: {} };
  for (const name of Object.keys(containers ?? {})) {
    const container = containers[name];
    const addresses = await dockerExec(container, ['ip', '-json', 'addr', 'show'], exec);
    const qdiscs = {};
    for (const ifName of JSON.parse(addresses).map((entry) => entry.ifname).filter(Boolean)) {
      qdiscs[ifName] = await dockerExec(container, ['tc', 'qdisc', 'show', 'dev', ifName], exec);
    }
    raw.containers[name] = {
      container,
      addresses,
      qdiscs,
      established: await dockerExec(container, ['ss', '-Htn', 'state', 'established'], exec),
      ...(name === 'origin' ? { listeners: await dockerExec(container, ['ss', '-Htln'], exec) } : {}),
    };
  }
  return raw;
}

export async function readMediaCountersAsync({ container, exec = asyncExec } = {}) {
  if (!container) throw new Error('origin container is required for media counters');
  return JSON.parse(await dockerExec(container, ['node', '-e', MEDIA_COUNTERS_SCRIPT], exec));
}

export function serviceNames(clients, { delivery = 'http' } = {}) {
  return ['origin', ...(delivery === 'host' ? ['server'] : []), 'sink',
    ...Array.from({ length: clients }, (_, index) => `c${String(index + 1).padStart(2, '0')}`)];
}

async function waitForOrigin(originUrl, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${originUrl}/room.html`, { cache: 'no-store' });
      if (response.ok) return true;
      lastError = new Error(`origin answered HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`origin never became reachable at ${originUrl}: ${lastError?.message}`);
}

async function waitForAgent(tag, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${agentPortFor(tag)}/status`, { cache: 'no-store' });
      if (response.ok) return response.json();
      lastError = new Error(`agent answered HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`client ${tag} agent never answered: ${lastError?.message}`);
}

async function agentPost(tag, pathname, body = {}) {
  const response = await fetch(`http://127.0.0.1:${agentPortFor(tag)}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`agent ${tag} ${pathname}: ${value.error ?? response.status}`);
  return value;
}

function controlUdpDrop({ container, ifName, subnet = null, exec = defaultExec }) {
  const qdisc = ['tc', 'qdisc', 'add', 'dev', ifName, 'clsact'];
  exec(['docker', 'exec', container, ...qdisc]);
  const filters = [
    ['ingress', 'ip', 'match', 'ip', 'protocol', '17', '0xff'],
    ['ingress', 'ipv6', 'match', 'ip6', 'protocol', '17', '0xff'],
    ['egress', 'ip', 'match', 'ip', 'protocol', '17', '0xff'],
    ['egress', 'ipv6', 'match', 'ip6', 'protocol', '17', '0xff'],
  ].map(([direction, family, match, ipFamily, protocol, number, mask]) => [
    'tc', 'filter', 'add', 'dev', ifName, direction, 'protocol', family, 'u32', match, ipFamily, protocol, number, mask, 'action', 'drop',
  ]);
  for (const argv of filters) exec(['docker', 'exec', container, ...argv]);
  const readBack = {};
  for (const direction of ['ingress', 'egress']) {
    readBack[direction] = dockerExec(container, ['tc', '-s', 'filter', 'show', 'dev', ifName, direction], exec);
    // tc prints the u32 match in hex: UDP is 0x11 in the IPv4 protocol byte
    // (offset 8) and in the IPv6 next-header byte (offset 4).
    const blocks = readBack[direction].split(/\n\s*\n/);
    for (const [family, match] of [['ip', 'match 00110000/00ff0000 at 8'], ['ipv6', 'match 00001100/0000ff00 at 4']]) {
      const found = blocks.some((block) => block.includes(`filter protocol ${family} `) && block.includes(match) && block.includes('gact action drop'));
      if (!found) throw new Error(`control UDP drop filter ${direction}/${family} did not read back on ${ifName}`);
    }
  }
  return { ifName, subnet, argv: [qdisc, ...filters], readBack };
}

function networkGateway(networkName, exec, project) {
  const inspected = JSON.parse(exec(['docker', 'network', 'inspect', `${project}_${networkName}`]));
  const gateway = (inspected?.[0]?.IPAM?.Config ?? []).map((entry) => entry.Gateway).find(Boolean);
  if (!gateway) throw new Error(`${project}_${networkName} declares no IPv4 gateway`);
  return gateway;
}

// Chrome without media permission gathers host candidates on the default-route
// interface only, so a host run points every browser container's default route at
// wa-media (7a2 design.md D3, observation). A read-back that differs aborts the run.
function mediaDefaultRoute({ container, subnet, gateway, exec = defaultExec }) {
  const { ifName } = resolveInterface(container, subnet, exec);
  const argv = ['ip', 'route', 'replace', 'default', 'via', gateway, 'dev', ifName];
  dockerExec(container, argv, exec);
  const readBack = JSON.parse(dockerExec(container, ['ip', '-json', 'route', 'show', 'default'], exec));
  if (readBack.length !== 1 || readBack[0].gateway !== gateway || readBack[0].dev !== ifName) {
    throw new Error(`default route on ${container} did not read back as ${gateway} dev ${ifName}: ${JSON.stringify(readBack)}`);
  }
  return { container, ifName, gateway, argv, readBack };
}

async function readLoopbackCounter(container, exec = asyncExec) {
  const value = Number((await dockerExec(container, ['cat', '/sys/class/net/lo/statistics/tx_bytes'], exec)).trim());
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid loopback tx_bytes for ${container}`);
  return { atMs: Date.now(), txBytes: value };
}

async function readViewerLinkCounter(container, ifName, exec = asyncExec) {
  const value = Number((await dockerExec(container, ['cat', `/sys/class/net/${ifName}/statistics/tx_bytes`], exec)).trim());
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid viewer tx_bytes for ${container}/${ifName}`);
  return { atMs: Date.now(), txBytes: value, interface: ifName, container };
}

export function imageDigests(exec = defaultExec) {
  const read = (image) => {
    try {
      return JSON.parse(exec(['docker', 'image', 'inspect', image]))[0]?.Id ?? null;
    } catch (error) {
      return `unavailable: ${error.message}`;
    }
  };
  return { origin: read('wa6a-origin:latest'), client: read('wa6a-client:latest') };
}

/**
 * The content's frame rate, read from the media every run. No constant is
 * substituted: an absent reading aborts rather than publishing a figure whose
 * denominator was assumed (executor-spec.md §10).
 */
export function readContentFrameRate(container, exec = defaultExec) {
  // The init segment alone reports a meaningless `12288/1` — it carries no
  // video samples — so it is concatenated with one media segment, which is what
  // `verify-frames.mjs` already does for the same reason.
  const ratio = dockerExec(container, ['sh', '-c',
    'set -e; cat /media/init.mp4 /media/seg-00000.m4s > /tmp/frame-rate-probe.mp4; '
    + 'ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=nw=1:nk=1 /tmp/frame-rate-probe.mp4; '
    + 'rm -f /tmp/frame-rate-probe.mp4',
  ], exec).trim();
  const [numerator, denominator] = ratio.split('/').map(Number);
  const frameRate = denominator ? numerator / denominator : Number(ratio);
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error(`content frame rate unreadable: ${JSON.stringify(ratio)}`);
  return { frameRate, source: 'ffprobe(init.mp4 + seg-00000.m4s)', ratio };
}

export function validateContentManifest(content = {}, manifest = {}) {
  if (content.hostDir !== undefined && typeof content.identity !== 'string') throw new Error('content-invalid');
  // step0's manifest carries no identity field, so the legacy identity is matched by its numbers.
  if (content.identity === LEGACY_CONTENT_IDENTITY && !Object.prototype.hasOwnProperty.call(content, 'targetSeconds')) {
    if (manifest.segmentSeconds !== LEGACY_CONTENT.segmentSeconds
      || manifest.segmentCount !== LEGACY_CONTENT.segmentCount
      || manifest.totalBytes !== LEGACY_CONTENT.totalBytes) {
      throw new Error('content-legacy-mismatch');
    }
    return manifest;
  }
  if (content.identity !== manifest.identity) throw new Error('content-identity-mismatch');
  if (Object.prototype.hasOwnProperty.call(content, 'targetSeconds')
    && content.targetSeconds !== manifest.targetSeconds) throw new Error('content-target-mismatch');
  if (!Number.isFinite(manifest.segmentSeconds) || manifest.segmentSeconds <= 0) {
    throw new Error('content-segment-seconds-unavailable');
  }
  return manifest;
}

export function readMountedContentManifest({ container, runDir, content = {}, exec = defaultExec } = {}) {
  const raw = dockerExec(container, ['cat', '/media/content-manifest.json'], exec);
  let manifest;
  try { manifest = JSON.parse(raw); } catch (error) {
    throw new Error(`content-manifest-invalid:${error.message}`);
  }
  validateContentManifest(content, manifest);
  fs.writeFileSync(path.join(runDir, 'content-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// Sets each variable for the call, undefined meaning unset, and restores what was there.
function withEnv(values, body) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const assign = (entries) => {
    for (const [name, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  assign(values);
  try {
    return body();
  } finally {
    assign(previous);
  }
}

function containerRunDir(runDir) {
  return `/results/${path.basename(runDir)}`;
}

export function probePathsFromContainers(containers, condition) {
  const paths = Object.fromEntries(armFor(condition).members(condition).declaredTags.map((tag) => {
    const container = tag === 'c00' ? containers.origin : containers[tag];
    if (!container) throw new Error(`probe path has no prepared container for ${tag}`);
    return [tag, {
      container,
      clockProbesCrossShapedUplink: container !== containers.origin,
      peerLinksShaped: false,
      origin: { container: containers.origin },
      ...(condition.delivery === 'host' && tag !== 'c00' ? { server: { container: containers.server } } : {}),
    }];
  }));
  return paths;
}

function startSampler({ container, ifName, runDir, intervalMs = 125, exec = defaultExec }) {
  const argv = [
    'sh', '-c',
    `cd /app && nohup node harness/sample-link.mjs --run-dir=${containerRunDir(runDir)} --interface=${ifName} --interval-ms=${intervalMs} > /tmp/sample-link.log 2>&1 &`,
  ];
  exec(['docker', 'exec', '-d', container, ...argv]);
  return { command: argv[2], intervalMs, ifName, container };
}

function startBackgroundLoad({ container, mbps, protocol = 'tcp', runDir, exec = defaultExec }) {
  if (mbps === null || mbps === undefined || mbps === 0) return { started: false, mbps: mbps ?? null };
  const report = `${containerRunDir(runDir)}/background-load.json`;
  const argv = [
    'sh', '-c',
    `cd /app && nohup node harness/background-load.mjs --to=sink:9500 --mbps=${mbps} --protocol=${protocol} --granularity-ms=10 --report=${report} > /tmp/background-load.log 2>&1 &`,
  ];
  exec(['docker', 'exec', '-d', container, ...argv]);
  return { started: true, mbps, report, command: argv[2] };
}

// The images carry no procps, so pkill and pgrep do not exist in them; node
// reads /proc instead. Prints the matching pids, signalling them if asked.
const PROCESSES = [
  "const fs = require('fs');",
  'const [pattern, signal] = process.argv.slice(1);',
  "const pids = fs.readdirSync('/proc').filter((d) => /^[0-9]+$/.test(d) && d !== '1' && Number(d) !== process.pid)",
  "  .filter((d) => { try { return fs.readFileSync('/proc/' + d + '/cmdline', 'utf8').includes(pattern); } catch { return false; } });",
  'if (signal) for (const pid of pids) process.kill(Number(pid), signal);',
  'console.log(JSON.stringify(pids.map(Number)));',
].join('\n');

function processes(container, pattern, exec, signal = '') {
  return JSON.parse(dockerExec(container, ['node', '-e', PROCESSES, pattern, signal], exec).trim());
}

function stopInContainer(container, pattern, exec = defaultExec) {
  try {
    const pids = processes(container, pattern, exec, 'SIGTERM');
    return { container, pattern, signalled: pids.length > 0, pids };
  } catch (error) {
    return { container, pattern, signalled: false, detail: error.message };
  }
}

/**
 * Whether a process matching `pattern` is still running. A failed read throws
 * rather than reading as exited.
 */
function running(container, pattern, exec) {
  return processes(container, pattern, exec).length > 0;
}

// The sender writes its report on SIGTERM, but compose down kills it with the
// container, so teardown waits for it to exit first (6b design.md D1).
async function waitForExit(container, pattern, exec, timeoutMs = 5000) {
  const startedAt = Date.now();
  try {
    while (running(container, pattern, exec)) {
      if (Date.now() - startedAt > timeoutMs) return { exited: false, waitedMs: Date.now() - startedAt };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    return { exited: null, error: error.message };
  }
  return { exited: true, waitedMs: Date.now() - startedAt };
}

/**
 * What the sink actually received. Read from its own stdout rather than from
 * the sender's count: the `filler-null` arm asserts zero bytes at the RECEIVER,
 * and a sender reporting that it sent nothing is the claim under test.
 */
export function readSinkCount({ container, exec = defaultExec } = {}) {
  try {
    const text = exec(['docker', 'logs', '--tail', '50', container]);
    const line = text.trim().split('\n').filter((entry) => entry.trim().startsWith('{')).pop();
    return line ? JSON.parse(line) : { totalBytes: 0, connections: 0, note: 'sink printed no report line' };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * The topology object the driver takes. `prepare` is everything that must exist
 * before a client opens a page; `applyQdiscs` is separate because the driver
 * records the read-back between the two and a failed read-back must stop the
 * run before any client starts (executor-spec.md §3, Boundaries).
 */
export function createComposeTopology({ project = PROJECT, exec = defaultExec, execAsync = asyncExec, originUrl = ORIGIN_HOST_URL, samplerIntervalMs = 125, down = true } = {}) {
  const state = { containers: {}, origin: null, control: null, controlUdpDrop: null, sampler: null, backgroundLoad: null, subnets: new Map(), runDir: null, urls: urlsForDelivery('http'), boundaries: {} };

  return {
    state,
    get originUrl() { return state.urls.countersUrl ?? originUrl; },
    get clientOriginUrl() { return state.urls.clientOriginUrl; },
    get hostPageUrl() { return state.urls.hostPageUrl; },

    async prepare({ condition, runDir }) {
      const arm = armFor(condition);
      if (condition.content?.hostDir !== undefined && typeof condition.content?.identity !== 'string') {
        throw new Error('content-invalid');
      }
      state.urls = urlsForDelivery(condition.delivery);
      state.runDir = runDir;
      const services = serviceNames(condition.clients, { delivery: condition.delivery });
      withEnv({
        WA_DELIVERY: condition.delivery,
        // Left as found when the condition names no directory.
        ...(condition.content?.hostDir !== undefined ? { WA_MEDIA_DIR: path.resolve(APP_DIR, condition.content.hostDir) } : {}),
        WA_TRACKER_PORT: arm.trackerPort === null ? undefined : arm.trackerPort,
        WA_ORIGIN_ROLE: condition.delivery === 'host' ? 'host-page' : undefined,
      }, () => compose(['up', '-d', '--no-build', ...services], { project, exec }));
      state.containers = composeContainers(project, exec);
      const missing = services.filter((name) => !state.containers[name]);
      if (missing.length) throw new Error(`compose did not start: ${missing.join(', ')}`);
      if (condition.delivery === 'host' && !state.containers.server) throw new Error('host delivery requires server container');
      await waitForOrigin(state.urls.countersUrl);
      const contentManifest = readMountedContentManifest({ container: state.containers.origin, runDir,
        content: condition.content, exec });
      await requireDelivery(state.urls.countersUrl, condition.delivery, {
        trackerUrl: arm.trackerPort === null ? null : `ws://${condition.delivery === 'host' ? 'server-media' : 'origin-media'}:${arm.trackerPort}`,
      });

      const subnet = networkSubnet(MEDIA_NETWORK, exec, project);
      state.subnets.set(MEDIA_NETWORK, subnet);
      state.origin = resolveInterface(state.containers.origin, subnet, exec);

      const agents = await arm.prepareTopology(state, {
        condition,
        services,
        exec,
        project,
        controlNetwork: CONTROL_NETWORK,
        mediaNetwork: MEDIA_NETWORK,
        networkSubnet: (networkName, runner) => networkSubnet(networkName, runner, project),
        networkGateway: (networkName, runner) => networkGateway(networkName, runner, project),
        controlUdpDrop,
        mediaDefaultRoute,
        resolveInterface,
        waitForAgent,
      });
      for (let index = 1; index <= condition.clients; index++) {
        const tag = `c${String(index).padStart(2, '0')}`;
        agents[tag] = await waitForAgent(tag);
      }
      const versions = new Set(Object.values(agents).map((agent) => agent.chromeVersion));
      if (versions.size > 1) throw new Error(`clients run ${versions.size} browser builds: ${[...versions].join(' | ')}`);

      state.sampler = startSampler({ container: state.containers.origin, ifName: state.origin.ifName, runDir, intervalMs: samplerIntervalMs, exec });
      state.backgroundLoad = startBackgroundLoad({ container: state.containers.origin, mbps: condition.backgroundLoadMbps, protocol: condition.backgroundLoadProtocol ?? 'tcp', runDir, exec });

      const content = { ...condition.content, segmentSeconds: contentManifest.segmentSeconds,
        identity: contentManifest.identity ?? condition.content?.identity, ...readContentFrameRate(state.containers.origin, exec) };
      return {
        containers: state.containers,
        countersUrl: state.urls.countersUrl,
        clientOriginUrl: state.urls.clientOriginUrl,
        hostPageUrl: state.urls.hostPageUrl,
        probePaths: probePathsFromContainers(state.containers, condition),
        originInterface: state.origin,
        sampler: state.sampler,
        backgroundLoad: state.backgroundLoad,
        content,
        ...arm.topologyEvidence(state),
        regime: {
          ...condition,
          images: imageDigests(exec),
          chromeVersion: [...versions][0] ?? null,
          chromeFlags: arm.chromeFlags(agents),
          agents,
          samplerIntervalMs,
          originInterface: state.origin,
        },
      };
    },

    async applyQdiscs({ condition }) {
      return applyQdiscs({ condition, containers: state.containers, exec, subnets: state.subnets });
    },

    async stepQdisc({ capacityStep }) {
      return changeQdisc({ state, capacityStep, exec });
    },

    async teardown({ condition }) {
      const report = { stopped: [], cleared: [], down: false };
      if (state.controlUdpDrop) {
        report.controlUdpDrop = {
          ifName: state.controlUdpDrop.ifName,
          ingress: dockerExec(state.containers.origin, ['tc', '-s', 'filter', 'show', 'dev', state.controlUdpDrop.ifName, 'ingress'], exec),
          egress: dockerExec(state.containers.origin, ['tc', '-s', 'filter', 'show', 'dev', state.controlUdpDrop.ifName, 'egress'], exec),
        };
      }
      if (state.containers.origin) {
        report.stopped.push(stopInContainer(state.containers.origin, 'sample-link.mjs', exec));
        report.stopped.push(stopInContainer(state.containers.origin, 'background-load.mjs', exec));
        if (state.backgroundLoad?.started) {
          report.backgroundLoadExit = await waitForExit(state.containers.origin, 'background-load.mjs', exec);
        }
      }
      if (state.containers.sink && state.backgroundLoad?.started) {
        report.sink = readSinkCount({ container: state.containers.sink, exec });
      }
      if (condition) report.cleared = clearCondition({ condition, containers: state.containers, exec, subnets: state.subnets });
      if (down) {
        compose(['down', '--remove-orphans'], { project, exec });
        report.down = true;
      }
      if (state.runDir) fs.writeFileSync(path.join(state.runDir, 'teardown.json'), `${JSON.stringify(report, null, 2)}\n`);
      return report;
    },

    async readLoopbackCounter() {
      if (!state.containers.origin) throw new Error('origin is not prepared');
      return readLoopbackCounter(state.containers.origin, execAsync);
    },

    async readViewerLinkCounters() {
      const clients = {};
      for (const tag of Object.keys(state.mediaDefaultRoute ?? {}).filter((name) => /^c\d+$/.test(name))) {
        const route = state.mediaDefaultRoute[tag];
        const container = state.containers[tag];
        if (!container || !route?.ifName) throw new Error(`viewer media route is unavailable for ${tag}`);
        clients[tag] = await readViewerLinkCounter(container, route.ifName, execAsync);
      }
      return { clients };
    },

    async captureBoundary({ kind, condition, runDir, room, viewers = null }) {
      if (condition.delivery !== 'host') return null;
      const raw = await readTopologyAsync({ containers: state.containers, exec: execAsync });
      const subnet = state.subnets.get(MEDIA_NETWORK);
      raw.mediaAddresses = {};
      for (const name of ['origin', 'server']) {
        raw.mediaAddresses[name] = (await resolveInterfaceAsync(state.containers[name], subnet, execAsync)).address;
      }
      // `viewers`: the ones in the room at this boundary, where a roster event changed them.
      const readback = topologyReadback({ raw, declaredViewers: viewers ?? armFor(condition).members(condition).tags });
      const media = await readMediaCountersAsync({ container: state.containers.origin, exec: execAsync });
      const boundary = { raw, readback, media };
      state.boundaries[kind] = { ...boundary, room };
      if (kind === 'end') {
        boundary.loopback = hostSourceOnLoopback({
          serverStart: state.boundaries.start?.room,
          serverEnd: room,
          mediaStart: state.boundaries.start?.media,
          mediaEnd: media,
          readback,
        });
        fs.writeFileSync(path.join(runDir, 'host-source-loopback.json'), `${JSON.stringify(boundary.loopback, null, 2)}\n`);
      }
      fs.writeFileSync(path.join(runDir, `topology-${kind}.json`), `${JSON.stringify({ raw, readback, ...(boundary.loopback ? { loopback: boundary.loopback } : {}) }, null, 2)}\n`);
      fs.writeFileSync(path.join(runDir, `media-counters-${kind}.json`), `${JSON.stringify(media, null, 2)}\n`);
      return boundary;
    },

    async clientFactory({ tag }) {
      const tab = await attach(cdpPortFor(tag), 'about:blank', { label: tag });
      const version = await tab.send('Browser.getVersion');
      return {
        tab,
        browserVersion: version?.product ?? null,
        container: state.containers[tag] ?? null,
        async dispose() {
          try {
            return await agentPost(tag, '/dispose');
          } finally {
            tab.ws?.close?.();
          }
        },
        async startEcho({ room, out, intervalMs = 250, condition }) {
          const origin = condition?.delivery === 'host' ? SERVER_CLIENT_URL : CLIENT_ORIGIN_URL;
          return agentPost(tag, '/echo/start', { room, out, intervalMs, originUrl: origin, tag });
        },
      };
    },
  };
}

export function composeDown({ project = PROJECT, exec = defaultExec } = {}) {
  return compose(['down', '--remove-orphans'], { project, exec });
}

export function composeUp({ project = PROJECT, exec = defaultExec, clients = 1, delivery = 'http' } = {}) {
  compose(['up', '-d', '--no-build', ...serviceNames(clients, { delivery })], { project, exec });
  return composeContainers(project, exec);
}
