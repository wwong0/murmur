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
import { prepareRunDirectory } from './runner/core.mjs';
import { applyQdiscs, clearInterface, defaultExec, dockerExec, networkSubnet, parseQdiscLines, resolveInterface } from '../harness/apply-qdisc.mjs';
import { CLIENT_ORIGIN_URL, MEDIA_NETWORK, PROJECT, cdpPortFor, composeDown, composeUp, imageDigests } from './harness/topology.mjs';
import { qualifyCdpBytes } from './harness/qualification.mjs';
import { attach } from './cdp.mjs';
import { conditionForName } from './harness-run.mjs';
import { requireDelivery } from './delivery-pin.mjs';

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
  cap100GoodputMbps: [85, 105],
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

function sinkReports(container, exec) {
  let text;
  try {
    text = exec(['docker', 'logs', '--tail', '100', container]);
  } catch {
    return [];
  }
  return String(text).split('\n').flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return Number.isFinite(value.atMs) && Number.isFinite(value.udpBytes) ? [value] : [];
    } catch {
      return [];
    }
  });
}

async function measureUdpCapacity({ origin, sink, exec = defaultExec }) {
  const before = sinkReports(sink, exec);
  // TCP under loss backs off before the bucket is measured; UDP isolates the capacity (6b design.md D1).
  dockerExec(origin, ['node', 'harness/background-load.mjs', '--to=sink:9500', '--mbps=150', '--protocol=udp', '--granularity-ms=10', '--max-ms=10000', '--report=/tmp/udp-capacity.json'], exec);
  const sender = JSON.parse(dockerExec(origin, ['cat', '/tmp/udp-capacity.json'], exec));
  const until = Date.now() + 5_000;
  let after = sinkReports(sink, exec);
  while (!after.some((entry) => entry.atMs >= sender.endedAtMs) && Date.now() < until) {
    await sleep(100);
    after = sinkReports(sink, exec);
  }
  const start = [...before, ...after]
    .filter((entry) => entry.atMs <= sender.startedAtMs)
    .sort((left, right) => left.atMs - right.atMs)
    .at(-1);
  const end = after
    .filter((entry) => entry.atMs >= sender.endedAtMs)
    .sort((left, right) => left.atMs - right.atMs)[0];
  if (!start || !end) throw new Error('UDP capacity: sink reports do not bracket the bounded sender interval');
  const udpBytesDelta = end.udpBytes - start.udpBytes;
  if (udpBytesDelta < 0) throw new RangeError(`UDP capacity: sink udpBytes moved backwards (${start.udpBytes} to ${end.udpBytes})`);
  return {
    sender,
    start,
    end,
    udpBytesDelta,
    elapsedMs: end.atMs - start.atMs,
    mbps: (udpBytesDelta * 8 * 1000) / (10_000 * 1e6),
  };
}

function readOriginImpairment({ container, ifName, exec = defaultExec }) {
  const text = dockerExec(container, ['tc', '-s', 'qdisc', 'show', 'dev', ifName], exec);
  const lines = parseQdiscLines(text);
  const root = lines.find((entry) => entry.kind === 'tbf' && entry.handle === '10:' && entry.parent === 'root');
  const child = lines.find((entry) => entry.kind === 'netem' && entry.handle === '20:' && entry.parent === '10:1');
  const limitMatch = child?.line.match(/\blimit\s+(\d+)/);
  return {
    root,
    child,
    childLimit: limitMatch ? Number(limitMatch[1]) : null,
  };
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

// --- the arms ------------------------------------------------------------

async function armMeasurements(name, context) {
  const { containers, originMedia, clientMedia, tab, exec = defaultExec } = context;
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
  if (name === 'cap100') {
    return { goodput: measureGoodput(client, { exec }) };
  }
  if (name === 'loss5' || name === 'loss5-origin-only') {
    return {
      lossOriginToClient: await measureUdpLoss({ fromContainer: origin, toContainer: client, toAddress: clientMedia.address, port: 9603 }),
      lossClientToOrigin: await measureUdpLoss({ fromContainer: client, toContainer: origin, toAddress: originMedia.address, port: 9604 }),
    };
  }
  if (name === 'loss5-cap100') {
    return {
      lossOriginToClient: await measureUdpLoss({ fromContainer: origin, toContainer: client, toAddress: clientMedia.address, port: 9603, exec }),
      lossClientToOrigin: await measureUdpLoss({ fromContainer: client, toContainer: origin, toAddress: originMedia.address, port: 9604, exec }),
      originImpairment: readOriginImpairment({ container: origin, ifName: originMedia.ifName, exec }),
      udpCapacity: await measureUdpCapacity({ origin, sink: containers.sink, exec }),
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
  if (name === 'cap100') {
    assertions.push(within('goodput is at the declared 100 Mbps cap, two-sided', measured.goodput.mbps, BARS.cap100GoodputMbps));
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
  if (name === 'loss5-cap100') {
    assertions.push(withinFraction('origin to client loss is 3-7%', lossOf(measured.lossOriginToClient), BARS.impairedLossFraction));
    assertions.push(withinFraction('client to origin loss is 3-7%', lossOf(measured.lossClientToOrigin), BARS.impairedLossFraction));
    const impairment = measured.originImpairment;
    assertions.push(assertion('origin read-back has tbf 10: at root and netem 20: under 10:1',
      Boolean(impairment?.root && impairment?.child), { root: impairment?.root ?? null, child: impairment?.child ?? null }));
    assertions.push(assertion('netem child limit is recorded from tc -s qdisc',
      Number.isInteger(impairment?.childLimit) && impairment.childLimit > 0, { childLimit: impairment?.childLimit ?? null }));
    assertions.push(within('UDP sink capacity reaches the 100 Mbps bucket, two-sided', measured.udpCapacity.mbps, BARS.cap100GoodputMbps,
      { udpBytesDelta: measured.udpCapacity.udpBytesDelta, elapsedMs: measured.udpCapacity.elapsedMs }));
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
    await requireDelivery('http://127.0.0.1:8110', 'http');
    const subnet = networkSubnet(MEDIA_NETWORK, exec, project);
    const originMedia = resolveInterface(containers.origin, subnet, exec);
    const clientMedia = resolveInterface(containers.c01, subnet, exec);
    await waitForClient();
    tab = await attach(cdpPortFor('c01'), 'about:blank', { label: 'c01' });
    const context = { containers, originMedia, clientMedia, tab, exec };

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
