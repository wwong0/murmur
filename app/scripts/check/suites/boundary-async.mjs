// A boundary read-back awaits its `docker exec`s, so the
// poll loops run through it; the join's brackets and each page's largest poll
// gap are published; a host gap inside a span reads it incomplete where declared.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, assertEqual, check } from '../harness.mjs';
import { asyncExec, defaultExec } from '../../../harness/apply-qdisc.mjs';
import { createComposeTopology, MEDIA_NETWORK, readTopology } from '../../harness/topology.mjs';
import { computeControlFigures, recoverySpans, timebaseJoin } from '../../figures/control-figures.mjs';
import { bracketHalfWidths, largestPollGap } from '../../figures/poll-coverage.mjs';

const READBACK_MS = 4_000;
const POLL_MS = 250;
const ADDRESSES = { origin: '172.30.0.2', server: '172.30.0.3', c01: '172.30.0.11' };

// A clock that moves only when its driver fires a timer, or when a blocking
// call moves it with no timer firing, which is what a synchronous exec does.
function fakeClock() {
  let t = 0;
  const timers = [];
  const sleep = (ms) => new Promise((resolve) => { timers.push({ at: t + ms, resolve }); });
  const turn = () => new Promise((resolve) => { setImmediate(resolve); });
  async function runUntil(promise) {
    let settled = false;
    const tracked = promise.finally(() => { settled = true; });
    tracked.catch(() => {});
    for (;;) {
      await turn();
      if (settled) return tracked;
      if (!timers.length) throw new Error('fake clock: nothing is pending');
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      t = Math.max(t, next.at);
      next.resolve();
    }
  }
  return { now: () => t, block: (ms) => { t += ms; }, sleep, runUntil };
}

function outputFor(argv) {
  const [, , container, ...command] = argv;
  const text = command.join(' ');
  if (text.startsWith('ip -json')) {
    return JSON.stringify([
      { ifname: 'lo', addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8 }] },
      { ifname: 'eth-media', addr_info: [{ family: 'inet', local: ADDRESSES[container], prefixlen: 24 }] },
    ]);
  }
  if (text.startsWith('tc qdisc show')) return 'qdisc noqueue 0: root';
  if (text.startsWith('ss ')) return '';
  if (text.startsWith('node -e')) return '{"responses":0}';
  throw new Error(`unexpected exec: ${text}`);
}

// Both fakes take 4 000 ms over their first call and none over the rest: the
// asynchronous one on a timer, the synchronous one by holding the thread.
function world() {
  const clock = fakeClock();
  let asyncCalls = 0;
  let syncCalls = 0;
  const execAsync = async (argv) => {
    asyncCalls += 1;
    if (asyncCalls === 1) await clock.sleep(READBACK_MS);
    return outputFor(argv);
  };
  const exec = (argv) => {
    syncCalls += 1;
    if (syncCalls === 1) clock.block(READBACK_MS);
    return outputFor(argv);
  };
  const polls = [];
  const loop = { stopped: false };
  (async () => {
    while (!loop.stopped) { polls.push(clock.now()); await clock.sleep(POLL_MS); }
  })();
  return { clock, exec, execAsync, polls, stop: () => { loop.stopped = true; } };
}

const containers = () => ({ origin: 'origin', server: 'server', c01: 'c01' });
const every250 = (fromMs, toMs, skip = () => false) => {
  const polls = [];
  for (let at = fromMs; at <= toMs; at += POLL_MS) if (!skip(at)) polls.push({ harnessBeforeMs: at - 2, harnessAfterMs: at });
  return polls;
};

async function thrownBy(run) {
  try { await run(); } catch (error) { return error; }
  return null;
}

export default async function boundaryAsyncSuite() {
  await check('boundary async: the polls run every 250 ms through a 4 000 ms read-back', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-async-'));
    try {
      const fake = world();
      const topology = createComposeTopology({ exec: fake.exec, execAsync: fake.execAsync, down: false });
      topology.state.containers = containers();
      topology.state.subnets.set(MEDIA_NETWORK, '172.30.0.0/24');
      const boundary = await fake.clock.runUntil(topology.captureBoundary({
        kind: 'start', condition: { delivery: 'host', clients: 1 }, runDir, room: null }));
      fake.stop();
      const during = fake.polls.filter((at) => at < 4_000);
      assertEqual(during.join(','), Array.from({ length: 16 }, (_, index) => index * 250).join(','),
        'sixteen polls, one every 250 ms from 0 to 3 750, inside the read-back');
      assertEqual(fake.clock.now(), 4_000, 'the read-back took 4 000 ms of the fake clock');
      assertEqual(boundary.readback.origin.mediaAddress, '172.30.0.2', 'the read-back is the one the awaited execs returned');
      assertEqual(boundary.media.responses, 0, 'and the media counters with it');
      assert(fs.existsSync(path.join(runDir, 'topology-start.json')), 'the boundary file is written');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
    // Prevention claim: a boundary read-back cannot stop the poll loops.
    // Opportunity: a 4 000 ms exec while a loop polls every 250 ms. Action boundary:
    // captureBoundary. Mutation, with topology.mjs copied aside: captureBoundary's
    // `await readTopologyAsync({ ..., exec: execAsync })` replaced by the synchronous
    // `readTopology({ ..., exec })`. `npm run check` turned 'the read-back took
    // `readTopology({ ..., exec })`. `npm run check` turned 'sixteen polls, one every
    // 250 ms from 0 to 3 750, inside the read-back' red (got "0"). Restored from the
    // copy, diff empty; green again.
  });

  await check('boundary async: the synchronous form leaves no poll inside the same 4 000 ms', async () => {
    const fake = world();
    const raw = await fake.clock.runUntil((async () => readTopology({ containers: containers(), exec: fake.exec }))());
    fake.stop();
    assertEqual(fake.clock.now(), 4_000, 'the same 4 000 ms passed');
    assertEqual(Object.keys(raw.containers).join(','), 'origin,server,c01', 'and the same three containers were read');
    assertEqual(fake.polls.filter((at) => at > 0 && at < 4_000).length, 0, 'no poll strictly inside the read-back');
    assertEqual(fake.polls.join(','), '0', 'the loop polled before it only');
  });

  await check('boundary async: asyncExec returns and throws as defaultExec does', async () => {
    const ok = [process.execPath, '-e', 'process.stdout.write("out")'];
    const bad = [process.execPath, '-e', 'process.exit(3)'];
    assertEqual(await asyncExec(ok), 'out', 'stdout is returned');
    assertEqual(defaultExec(ok), 'out', 'as the synchronous form returns it');
    const asyncError = await thrownBy(() => asyncExec(bad));
    const syncError = await thrownBy(async () => defaultExec(bad));
    assertEqual(syncError?.status, 3, 'the synchronous form throws with status 3');
    assertEqual(asyncError?.status, 3, 'the asynchronous form throws with the same status');
  });

  await check('boundary async: brackets of 10, 12 and 4 000 ms publish half their median and half their maximum', async () => {
    const polls = [[0, 10], [1_000, 1_012], [2_000, 6_000]].map(([before, after], index) => ({
      harnessBeforeMs: before, harnessAfterMs: after, pageWallMs: 50_000 + (before + after) / 2,
      sharedMs: 100 + (before + after) / 2, clock: { halfWidthMs: 2 + index },
      state: { held: true, lineage: 'l', version: 1, atSharedMs: 100 } }));
    const widths = bracketHalfWidths(polls);
    assertEqual(widths.medianMs, 6, 'half of the median bracket, 12 ms');
    assertEqual(widths.maxMs, 2_000, 'half of the widest bracket, 4 000 ms');
    const join = timebaseJoin(polls);
    assertEqual(join.bracketHalfWidthMedianMs, 6, 'the join returns the median half-width');
    assertEqual(join.bracketHalfWidthMaxMs, 2_000, 'and the maximum half-width');
    assertEqual(join.halfWidthMs, 2_003, 'halfWidthMs keeps its definition: widest bracket half plus median clock half-width');
    const backwards = await thrownBy(async () => bracketHalfWidths([{ harnessBeforeMs: 10, harnessAfterMs: 0 }]));
    assert(backwards instanceof RangeError, 'a bracket that ends before it begins is a hard error');
    const figures = computeControlFigures({ condition: { peerExchange: true }, declaredClientTags: [], clients: {}, hostPoll: polls,
      viewerPolls: { c01: every250(0, 5_000, (at) => at > 1_000 && at < 3_000) }, clockJoin: {}, resumes: { records: [] } });
    assertEqual(figures.timebase.bracketHalfWidthMedianMs, 6, 'the figures publish the median half-width');
    assertEqual(figures.timebase.bracketHalfWidthMaxMs, 2_000, 'and the maximum');
    assertEqual(figures.timebase.halfWidthMs, 2_003, 'beside the registered half-width');
    assertEqual(JSON.stringify(figures.pollGaps.host), JSON.stringify({ maxGapMs: 4_988, fromMs: 1_012, toMs: 6_000 }),
      'the host\'s largest poll gap and its two instants');
    assertEqual(JSON.stringify(figures.pollGaps.viewers.c01), JSON.stringify({ maxGapMs: 2_000, fromMs: 1_000, toMs: 3_000 }),
      'and the viewer\'s');
    assertEqual(largestPollGap([{ harnessAfterMs: 5 }]), null, 'one poll has no gap, and null says so');
  });

  await check('boundary async: a host poll gap of 3 900 ms inside a span reads it incomplete where declared', async () => {
    // The pair differs only in the host's polls between 10 000 and 13 900 ms.
    const span = (hostPoll, reading) => recoverySpans({ input: { condition: { bars: {}, reading },
      declaredClientTags: ['c01'], clients: { c01: { records: [], polls: [] } }, segmentSeconds: 4, hostPoll,
      viewerPolls: { c01: every250(0, 60_000) }, linkSamples: [], hostPace: null, capacityBitsPerSecond: 10_000_000 },
    transition: 0, recordingEnd: 60_000 }).spans[0];
    const whole = every250(0, 60_000);
    const gapped = every250(0, 60_000, (at) => at > 10_000 && at < 13_900);
    assertEqual(whole.length - gapped.length, 15, 'the fixtures differ by the fifteen polls of the gap');
    const declared = { kind: 'control', hostPollCoverage: true };
    assertEqual(span(whole, declared).incomplete, false, 'host polls every 250 ms leave the span complete');
    assertEqual(span(gapped, declared).incomplete, true, 'a 3 900 ms host gap reads it incomplete');
    assertEqual(span(gapped, { kind: 'control' }).incomplete, false, 'a condition that does not declare it reads as it was registered');
  });
}
