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

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach } from '../cdp.mjs';
import { applyQdiscs, clearCondition, defaultExec, dockerExec, networkSubnet, resolveInterface } from '../../harness/apply-qdisc.mjs';

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'harness');
const COMPOSE_FILE = path.join(HARNESS_DIR, 'compose.yaml');

export const PROJECT = 'wa6a';
export const MEDIA_NETWORK = 'wa-media';
export const ORIGIN_HOST_URL = 'http://127.0.0.1:8110';
// The MEDIA alias, never the bare service name: `origin` resolves to both of
// the origin's addresses and a client that picked the control one would fetch
// its media past the shaped interface (compose.yaml).
export const CLIENT_ORIGIN_URL = 'http://origin-media:8100';

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

export function serviceNames(clients) {
  return ['origin', 'sink', ...Array.from({ length: clients }, (_, index) => `c${String(index + 1).padStart(2, '0')}`)];
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

function containerRunDir(runDir) {
  return `/results/${path.basename(runDir)}`;
}

function startSampler({ container, ifName, runDir, intervalMs = 125, exec = defaultExec }) {
  const argv = [
    'sh', '-c',
    `cd /app && nohup node harness/sample-link.mjs --run-dir=${containerRunDir(runDir)} --interface=${ifName} --interval-ms=${intervalMs} > /tmp/sample-link.log 2>&1 &`,
  ];
  exec(['docker', 'exec', '-d', container, ...argv]);
  return { command: argv[2], intervalMs, ifName, container };
}

function startBackgroundLoad({ container, mbps, runDir, exec = defaultExec }) {
  if (mbps === null || mbps === undefined || mbps === 0) return { started: false, mbps: mbps ?? null };
  const report = `${containerRunDir(runDir)}/background-load.json`;
  const argv = [
    'sh', '-c',
    `cd /app && nohup node harness/background-load.mjs --to=sink:9500 --mbps=${mbps} --granularity-ms=10 --report=${report} > /tmp/background-load.log 2>&1 &`,
  ];
  exec(['docker', 'exec', '-d', container, ...argv]);
  return { started: true, mbps, report, command: argv[2] };
}

function stopInContainer(container, pattern, exec = defaultExec) {
  try {
    dockerExec(container, ['pkill', '-TERM', '-f', pattern], exec);
    return { container, pattern, signalled: true };
  } catch (error) {
    return { container, pattern, signalled: false, detail: error.message };
  }
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
export function createComposeTopology({ project = PROJECT, exec = defaultExec, originUrl = ORIGIN_HOST_URL, samplerIntervalMs = 125, down = true } = {}) {
  const state = { containers: {}, origin: null, sampler: null, backgroundLoad: null, subnets: new Map(), runDir: null };

  return {
    state,
    originUrl,
    clientOriginUrl: CLIENT_ORIGIN_URL,

    async prepare({ condition, runDir }) {
      state.runDir = runDir;
      compose(['up', '-d', '--no-build', ...serviceNames(condition.clients)], { project, exec });
      state.containers = composeContainers(project, exec);
      const missing = serviceNames(condition.clients).filter((name) => !state.containers[name]);
      if (missing.length) throw new Error(`compose did not start: ${missing.join(', ')}`);
      await waitForOrigin(originUrl);

      const subnet = networkSubnet(MEDIA_NETWORK, exec, project);
      state.subnets.set(MEDIA_NETWORK, subnet);
      state.origin = resolveInterface(state.containers.origin, subnet, exec);

      const agents = {};
      for (let index = 1; index <= condition.clients; index++) {
        const tag = `c${String(index).padStart(2, '0')}`;
        agents[tag] = await waitForAgent(tag);
      }
      const versions = new Set(Object.values(agents).map((agent) => agent.chromeVersion));
      if (versions.size > 1) throw new Error(`clients run ${versions.size} browser builds: ${[...versions].join(' | ')}`);

      state.sampler = startSampler({ container: state.containers.origin, ifName: state.origin.ifName, runDir, intervalMs: samplerIntervalMs, exec });
      state.backgroundLoad = startBackgroundLoad({ container: state.containers.origin, mbps: condition.backgroundLoadMbps, runDir, exec });

      const content = { ...condition.content, ...readContentFrameRate(state.containers.origin, exec) };
      return {
        containers: state.containers,
        originInterface: state.origin,
        sampler: state.sampler,
        backgroundLoad: state.backgroundLoad,
        content,
        regime: {
          ...condition,
          images: imageDigests(exec),
          chromeVersion: [...versions][0] ?? null,
          chromeFlags: Object.values(agents)[0]?.flags ?? null,
          agents,
          samplerIntervalMs,
          originInterface: state.origin,
        },
      };
    },

    async applyQdiscs({ condition }) {
      return applyQdiscs({ condition, containers: state.containers, exec, subnets: state.subnets });
    },

    async teardown({ condition }) {
      const report = { stopped: [], cleared: [], down: false };
      if (state.containers.origin) {
        report.stopped.push(stopInContainer(state.containers.origin, 'sample-link.mjs', exec));
        report.stopped.push(stopInContainer(state.containers.origin, 'background-load.mjs', exec));
      }
      if (condition) report.cleared = clearCondition({ condition, containers: state.containers, exec, subnets: state.subnets });
      if (down) {
        compose(['down', '--remove-orphans'], { project, exec });
        report.down = true;
      }
      return report;
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
        async startEcho({ room, out, intervalMs = 250 }) {
          return agentPost(tag, '/echo/start', { room, out, intervalMs, originUrl: CLIENT_ORIGIN_URL, tag });
        },
      };
    },
  };
}

export function composeDown({ project = PROJECT, exec = defaultExec } = {}) {
  return compose(['down', '--remove-orphans'], { project, exec });
}

export function composeUp({ project = PROJECT, exec = defaultExec, clients = 1 } = {}) {
  compose(['up', '-d', '--no-build', ...serviceNames(clients)], { project, exec });
  return composeContainers(project, exec);
}
