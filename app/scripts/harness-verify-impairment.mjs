// Is the declared impairment real? (executor-spec.md §3.3, acceptance A2.)
//
// Nothing here publishes a figure. Every arm is rig verification: it applies
// one condition's qdiscs and measures whether the link behaves as the condition
// says, in both directions and against a bar declared in this file before any
// arm runs.
//
// `uncapped` is the positive control and is not optional. Without it "10 Mbps"
// could be the bridge's own ceiling and the cap10 assertion would pass against
// a qdisc that shapes nothing (CONSTRAINTS.md -> Verification, "a guard that
// cannot be reached cannot be tested"). `delay200` is the discrimination probe
// for the two-network split: it must move the media round trip and leave the
// CDP round trip where it was, because a qdisc on the interface the measurement
// is read over would be measured through itself.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { percentile } from '../public/lib/frame-drift.mjs';
import { createRequestRecorder } from './harness/cdp-records.mjs';
import { prepareRunDirectory } from './runner/core.mjs';
import { applyQdiscs, clearInterface, defaultExec, dockerExec, networkSubnet, resolveInterface } from '../harness/apply-qdisc.mjs';
import { CLIENT_ORIGIN_URL, MEDIA_NETWORK, PROJECT, cdpPortFor, composeDown, composeUp, imageDigests } from './harness/topology.mjs';
import { attach } from './cdp.mjs';
import { conditionForName } from './harness-run.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');

export const ARM_ORDER = ['uncapped', 'cap10', 'loss5', 'loss5-origin-only', 'delay200'];

// Declared before any arm runs and never moved afterwards. The loss bars are
// sized from the binomial: at p=0.05 over 2000 datagrams one standard deviation
// is 0.49pp, so +/-3 sigma is [3.5%, 6.5%] and [3.0%, 7.0%] adds margin for
// path effects. A narrower bar on a smaller population would be measuring noise.
export const BARS = Object.freeze({
  goodputMinMbps: 50,
  cappedGoodputMbps: [8.5, 10.5],
  cleanLossMaxFraction: 0.005,
  impairedLossFraction: [0.03, 0.07],
  cleanMediaRttP50MaxMs: 5,
  delayedMediaRttP50Ms: [190, 260],
  cdpRttDriftMaxMs: 5,
  decodeFramesMin: 100,
  decodeWindowMs: 10_000,
});

export const POPULATION = Object.freeze({ datagrams: 2000, datagramIntervalMs: 10, datagramSizeBytes: 200, segments: 40, pings: 25, cdpProbes: 25 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sorted = (values) => [...values].sort((left, right) => left - right);

export function assertion(name, ok, detail) {
  return { name, ok, detail };
}

/** Two-sided, with a hard error outside the physically possible. */
export function withinFraction(name, value, [low, high], detail = {}) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name}: ${value} is not a fraction; the instrument is broken, not the link`);
  }
  return assertion(name, value >= low && value <= high, { value, low, high, ...detail });
}

export function within(name, value, [low, high], detail = {}) {
  if (!Number.isFinite(value)) throw new Error(`${name}: ${value} is not a number`);
  return assertion(name, value >= low && value <= high, { value, low, high, ...detail });
}

function jsonFromStdout(text, label) {
  const line = String(text).trim().split('\n').filter((entry) => entry.trim().startsWith('{')).pop();
  if (!line) throw new Error(`${label}: no JSON on stdout — got ${JSON.stringify(String(text).slice(0, 400))}`);
  return JSON.parse(line);
}

// --- the measurements ----------------------------------------------------

export function measureGoodput(container, { origin = CLIENT_ORIGIN_URL, segments = POPULATION.segments, start = 0, exec = defaultExec } = {}) {
  const output = dockerExec(container, ['node', 'harness/goodput.mjs', `--origin=${origin}`, `--segments=${segments}`, `--start=${start}`], exec);
  const result = jsonFromStdout(output, 'goodput');
  if (result.incomplete.length) throw new Error(`goodput: ${result.incomplete.length} segment(s) arrived short of Content-Length`);
  return result;
}

/** Media round trip, to the origin's MEDIA address — never to the service name. */
export function measurePing(container, address, { count = POPULATION.pings, intervalS = 0.2, exec = defaultExec } = {}) {
  const output = dockerExec(container, ['ping', '-n', '-c', String(count), '-i', String(intervalS), '-W', '2', address], exec);
  const samples = [...output.matchAll(/time=([\d.]+)\s*ms/g)].map((match) => Number(match[1]));
  if (samples.length === 0) throw new Error(`ping ${address}: no replies parsed from ${JSON.stringify(output.slice(0, 300))}`);
  const order = sorted(samples);
  return {
    address,
    sent: count,
    replies: samples.length,
    p50: percentile(order, 0.5),
    p95: percentile(order, 0.95),
    min: order[0],
    max: order[order.length - 1],
    samples,
  };
}

export async function measureCdpRtt(tab, { count = POPULATION.cdpProbes } = {}) {
  const samples = [];
  for (let index = 0; index < count; index++) {
    const startedAt = process.hrtime.bigint();
    await tab.evaluate('1');
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  const order = sorted(samples);
  return { count, p50: percentile(order, 0.5), p95: percentile(order, 0.95), min: order[0], max: order[order.length - 1], samples };
}

/**
 * Loss in ONE direction, counted at the receiver by sequence number. The
 * sender's own count is recorded but never used to infer what arrived.
 */
export async function measureUdpLoss({ fromContainer, toContainer, toAddress, port, exec = defaultExec }) {
  const reportPath = `/tmp/udp-loss-${port}.json`;
  // The receiver stops on whichever comes first: the whole population, or the
  // budget. The count is what makes a clean arm finish in the twenty seconds it
  // takes to send, and the budget is what bounds an arm that loses the tail —
  // where the last datagram never arrives and the count is never reached.
  const budgetMs = POPULATION.datagrams * POPULATION.datagramIntervalMs + 8000;
  exec(['docker', 'exec', '-d', toContainer, 'sh', '-c',
    `cd /app && rm -f ${reportPath} && node harness/udp-loss.mjs --receive --port=${port} --count=${POPULATION.datagrams} --report=${reportPath} --max-ms=${budgetMs} > /tmp/udp-loss-rx.log 2>&1`]);
  await sleep(1500);
  const sent = jsonFromStdout(dockerExec(fromContainer, ['node', 'harness/udp-loss.mjs', '--send',
    `--to=${toAddress}:${port}`, `--count=${POPULATION.datagrams}`, `--interval-ms=${POPULATION.datagramIntervalMs}`,
    `--size=${POPULATION.datagramSizeBytes}`], exec), 'udp-loss send');
  // Waited for, not slept past. A fixed sleep shorter than the budget reads a
  // report the receiver has not written yet and reports an absent file as the
  // measurement's failure.
  const received = jsonFromStdout(await readWhenWritten(toContainer, reportPath, budgetMs + 5000, exec), 'udp-loss receive');
  return { from: fromContainer, to: toContainer, port, sent, received };
}

async function readWhenWritten(container, file, timeoutMs, exec) {
  const until = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < until) {
    try {
      return dockerExec(container, ['cat', file], exec);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`${container}:${file} never appeared within ${timeoutMs}ms — ${lastError?.message.split('\n')[0]}`);
}

/**
 * The codec, and an actual decode. `canPlayType` alone would pass against a
 * build that claims H.264 and decodes nothing, which is exactly what a Chromium
 * substituted for Google Chrome looks like.
 */
export async function verifyCodecAndDecode(tab, { origin = CLIENT_ORIGIN_URL, windowMs = BARS.decodeWindowMs } = {}) {
  await tab.send('Page.navigate', { url: `${origin}/room.html?room=codec-${Date.now()}&role=host&tab=q01` });
  await sleep(3000);
  const canPlay = await tab.evaluate(`document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"')`);
  const before = await tab.evaluate(`document.querySelector('video')?.getVideoPlaybackQuality?.()?.totalVideoFrames ?? null`);
  await sleep(windowMs);
  const after = await tab.evaluate(`document.querySelector('video')?.getVideoPlaybackQuality?.()?.totalVideoFrames ?? null`);
  return { canPlay, before, after, advancedBy: Number.isFinite(after) && Number.isFinite(before) ? after - before : null, windowMs };
}

/**
 * The CDP byte mapping, against a file whose size the origin reports
 * (executor-spec.md §5.4). Until this passes, no figure derived from the CDP
 * request records may be published, and the gate fails closed.
 */
export async function qualifyCdpBytes(tab, { originContainer, origin = CLIENT_ORIGIN_URL, segment = 'seg-01500.m4s', exec = defaultExec } = {}) {
  const statSizeBytes = Number(dockerExec(originContainer, ['stat', '-c', '%s', `/media/${segment}`], exec).trim());
  const recorder = createRequestRecorder(tab);
  try {
    await tab.send('Network.enable');
    await tab.send('Network.setCacheDisabled', { cacheDisabled: true });
    const pageClock = await tab.evaluate('({ wallMs: Date.now(), performanceNowMs: performance.now() })');
    recorder.setPageMapping(pageClock);
    const fetched = await tab.evaluate(`fetch('/media/${segment}', { cache: 'no-store' }).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
    await sleep(1000);
    const records = recorder.flush().filter((record) => String(record.url).endsWith(segment));
    if (records.length !== 1) throw new Error(`CDP qualification saw ${records.length} records for ${segment}, expected exactly 1`);
    const record = records[0];
    return {
      status: record.bodyBytesFromChunks === record.bodyBytesFromTotal && record.bodyBytesFromTotal === statSizeBytes ? 'passed' : 'failed',
      segment,
      statSizeBytes,
      fetchedBytes: fetched,
      bodyBytes: record.bodyBytes,
      bodyBytesFromChunks: record.bodyBytesFromChunks,
      bodyBytesFromTotal: record.bodyBytesFromTotal,
      source: record.source,
      origin,
      measuredAt: new Date().toISOString(),
    };
  } finally {
    recorder.dispose();
  }
}

// --- the arms ------------------------------------------------------------

async function armMeasurements(name, context) {
  const { containers, originMedia, clientMedia, tab } = context;
  const client = containers.c01;
  const origin = containers.origin;

  if (name === 'uncapped') {
    return {
      goodput: measureGoodput(client),
      ping: measurePing(client, originMedia.address),
      cdpRtt: await measureCdpRtt(tab),
      lossOriginToClient: await measureUdpLoss({ fromContainer: origin, toContainer: client, toAddress: clientMedia.address, port: 9601 }),
      lossClientToOrigin: await measureUdpLoss({ fromContainer: client, toContainer: origin, toAddress: originMedia.address, port: 9602 }),
    };
  }
  if (name === 'cap10') {
    return {
      goodput: measureGoodput(client),
      codec: await verifyCodecAndDecode(tab),
      cdpQualification: await qualifyCdpBytes(tab, { originContainer: origin }),
    };
  }
  if (name === 'loss5' || name === 'loss5-origin-only') {
    return {
      lossOriginToClient: await measureUdpLoss({ fromContainer: origin, toContainer: client, toAddress: clientMedia.address, port: 9603 }),
      lossClientToOrigin: await measureUdpLoss({ fromContainer: client, toContainer: origin, toAddress: originMedia.address, port: 9604 }),
    };
  }
  return { ping: measurePing(client, originMedia.address), cdpRtt: await measureCdpRtt(tab) };
}

export function evaluateArm(name, measured, previous = {}) {
  const assertions = [];
  const lossOf = (result) => result.received.lossFraction;

  if (name === 'uncapped') {
    assertions.push(assertion('goodput exceeds the positive control bar', measured.goodput.mbps > BARS.goodputMinMbps,
      { mbps: measured.goodput.mbps, bar: BARS.goodputMinMbps }));
    assertions.push(withinFraction('origin to client loss is at most 0.5%', lossOf(measured.lossOriginToClient), [0, BARS.cleanLossMaxFraction]));
    assertions.push(withinFraction('client to origin loss is at most 0.5%', lossOf(measured.lossClientToOrigin), [0, BARS.cleanLossMaxFraction]));
    assertions.push(within('media round trip p50 is under 5ms', measured.ping.p50, [0, BARS.cleanMediaRttP50MaxMs]));
  }
  if (name === 'cap10') {
    assertions.push(within('goodput is at the declared cap, two-sided', measured.goodput.mbps, BARS.cappedGoodputMbps));
    assertions.push(assertion('H.264 is claimed', measured.codec.canPlay === 'probably', { canPlayType: measured.codec.canPlay }));
    assertions.push(assertion('and decoded — frames advance over the window',
      Number.isFinite(measured.codec.advancedBy) && measured.codec.advancedBy >= BARS.decodeFramesMin,
      { advancedBy: measured.codec.advancedBy, bar: BARS.decodeFramesMin, windowMs: measured.codec.windowMs }));
    assertions.push(assertion('CDP byte mapping equals the known file size on both paths',
      measured.cdpQualification.status === 'passed', measured.cdpQualification));
  }
  if (name === 'loss5') {
    assertions.push(withinFraction('origin to client loss is 3-7%', lossOf(measured.lossOriginToClient), BARS.impairedLossFraction));
    assertions.push(withinFraction('client to origin loss is 3-7%', lossOf(measured.lossClientToOrigin), BARS.impairedLossFraction));
  }
  if (name === 'loss5-origin-only') {
    assertions.push(withinFraction('origin to client loss is 3-7%', lossOf(measured.lossOriginToClient), BARS.impairedLossFraction));
    assertions.push(withinFraction('client to origin loss stays at most 0.5% — the direction nothing was applied to',
      lossOf(measured.lossClientToOrigin), [0, BARS.cleanLossMaxFraction]));
  }
  if (name === 'delay200') {
    assertions.push(within('media round trip p50 carries the declared delay', measured.ping.p50, BARS.delayedMediaRttP50Ms));
    const drift = Math.abs(measured.cdpRtt.p50 - (previous.uncapped?.cdpRtt?.p50 ?? Number.NaN));
    assertions.push(assertion('CDP round trip is unchanged — the qdisc is on the interface the condition names',
      Number.isFinite(drift) && drift <= BARS.cdpRttDriftMaxMs,
      { p50: measured.cdpRtt.p50, uncappedP50: previous.uncapped?.cdpRtt?.p50 ?? null, drift, bar: BARS.cdpRttDriftMaxMs }));
  }
  return { name, assertions, ok: assertions.every((entry) => entry.ok) };
}

export async function runArms({ arms = ARM_ORDER, runDir, project = PROJECT, exec = defaultExec } = {}) {
  const prepared = prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir, createParents: true });
  const results = {};
  const measurements = {};
  let tab = null;
  try {
    const containers = composeUp({ project, exec, clients: 1 });
    const subnet = networkSubnet(MEDIA_NETWORK, exec, project);
    const originMedia = resolveInterface(containers.origin, subnet, exec);
    const clientMedia = resolveInterface(containers.c01, subnet, exec);
    await waitForClient();
    tab = await attach(cdpPortFor('c01'), 'about:blank', { label: 'c01' });
    const context = { containers, originMedia, clientMedia, tab };

    for (const name of arms) {
      const condition = conditionForName(`shakedown/${name}`);
      clearMediaQdiscs(context, exec);
      const applied = applyQdiscs({ condition, containers, exec });
      const measured = await armMeasurements(name, context);
      measurements[name] = measured;
      const verdict = evaluateArm(name, measured, measurements);
      results[name] = { ...verdict, condition: condition.name, qdiscs: applied, measured, evaluatedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(prepared.runDir, `arm-${name}.json`), `${JSON.stringify(results[name], null, 2)}\n`);
      // Cleared by interface rather than by condition: the condition names only
      // what it applied, and the next arm must inherit a bare link either way.
      clearMediaQdiscs(context, exec);
    }

    const verdict = {
      ok: Object.values(results).every((entry) => entry.ok),
      arms: Object.fromEntries(Object.entries(results).map(([name, entry]) => [name, { ok: entry.ok, assertions: entry.assertions }])),
      bars: BARS,
      population: POPULATION,
      images: imageDigests(exec),
      originInterface: originMedia,
      clientInterface: clientMedia,
      endedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(prepared.runDir, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
    return { runDir: prepared.runDir, verdict, results };
  } finally {
    try { tab?.ws?.close?.(); } catch {}
    composeDown({ project, exec });
  }
}

/**
 * Both media interfaces, unconditionally, between arms. A stale qdisc surviving
 * into the next arm would be an impairment nothing declared, and the arm that
 * inherits it reports the previous arm's link as its own.
 */
function clearMediaQdiscs({ containers, originMedia, clientMedia }, exec) {
  return [
    clearInterface(containers.origin, originMedia.ifName, exec),
    clearInterface(containers.c01, clientMedia.ifName, exec),
  ];
}

async function waitForClient(timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPortFor('c01')}/json/version`);
      if (response.ok) return true;
    } catch {}
    await sleep(500);
  }
  throw new Error('client c01 never exposed CDP');
}

export async function main(argv = process.argv.slice(2)) {
  const armArgument = argv.find((entry) => entry.startsWith('--arm='));
  const runDirArgument = argv.find((entry) => entry.startsWith('--run-dir='));
  const arms = armArgument ? [armArgument.slice('--arm='.length)] : ARM_ORDER;
  const runDir = runDirArgument
    ? path.resolve(runDirArgument.slice('--run-dir='.length))
    : path.join(RESULTS_DIR, `6a-impairment-${new Date().toISOString().replaceAll(':', '-')}`);
  const { verdict, runDir: written } = await runArms({ arms, runDir });
  console.log(JSON.stringify(verdict, null, 2));
  console.log(`\nretained: ${written}`);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
}
