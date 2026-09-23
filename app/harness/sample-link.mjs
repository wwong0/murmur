import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const USAGE = 'node harness/sample-link.mjs --run-dir=<path> --interface=<name> --interval-ms=<ms> [--out=<name>] [--max-ms=<ms>]';

function parseArgs(argv) {
  const allowed = new Set(['run-dir', 'interface', 'interval-ms', 'out', 'max-ms']);
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith('--') || !arg.includes('=')) throw new Error(`invalid argument "${arg}"; use ${USAGE}`);
    const [key, ...rest] = arg.slice(2).split('=');
    if (!allowed.has(key)) throw new Error(`unknown flag --${key}`);
    if (rest.length === 0 || rest.join('=') === '') throw new Error(`flag --${key} needs a value`);
    values[key] = rest.join('=');
  }
  for (const key of ['run-dir', 'interface', 'interval-ms']) {
    if (values[key] === undefined) throw new Error(`missing required flag --${key}`);
  }
  const intervalMs = finiteNonNegative(values['interval-ms'], 'interval-ms');
  if (intervalMs <= 0) throw new Error('--interval-ms must be greater than zero');
  const maxMs = values['max-ms'] === undefined ? null : finiteNonNegative(values['max-ms'], 'max-ms');
  return {
    runDir: values['run-dir'],
    ifName: values.interface,
    intervalMs,
    out: values.out ?? 'origin-link.ndjson',
    maxMs,
  };
}

function finiteNonNegative(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`--${name} must be a finite non-negative number`);
  return number;
}

function outputPath(runDir, out) {
  return path.resolve(path.isAbsolute(out) ? out : path.join(runDir, out));
}

function healthPath(outPath) {
  return outPath.endsWith('.ndjson') ? `${outPath.slice(0, -'.ndjson'.length)}-health.json` : `${outPath}-health.json`;
}

function readCounter(ifName, counter) {
  const filename = `/sys/class/net/${ifName}/statistics/${counter}`;
  const value = Number(fs.readFileSync(filename, 'utf8').trim());
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${counter} counter in ${filename}`);
  return value;
}

// JSON, not text: text tc prints a size near a multiple of 1024 as Kb or Mb, which
// the text parser cannot read, and a saturated queue lands there (6b design.md D1).
function readRootQdisc(ifName) {
  const text = execFileSync('tc', ['-s', '-j', 'qdisc', 'show', 'dev', ifName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parseQdiscJson(text);
}

/** The root qdisc from `tc -s -j`; absent kernel counters remain null, not zero. */
export function parseQdiscJson(text) {
  const root = JSON.parse(text).find((entry) => entry?.root === true);
  if (!root) throw new Error('tc output has no root qdisc');
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  return {
    kind: root.kind ?? null,
    sentBytes: count(root.bytes),
    sentPackets: count(root.packets),
    backlogBytes: count(root.backlog),
    backlogPackets: count(root.qlen),
    drops: count(root.drops),
    overlimits: count(root.overlimits),
    requeues: count(root.requeues),
  };
}

/** Parse only the root qdisc; absent kernel counters remain null, not zero. */
export function parseQdisc(text) {
  const lines = text.split(/\r?\n/);
  const rootIndex = lines.findIndex((line) => /^qdisc\s+\S+\s+\S+:\s+root(?:\s|$)/.test(line));
  const root = rootIndex === -1 ? null : lines[rootIndex];
  if (!root) throw new Error('tc output has no root qdisc');
  const kind = root.match(/^qdisc\s+(\S+)/)?.[1] ?? null;
  const nextQdisc = lines.findIndex((line, index) => index > rootIndex && /^qdisc\s+/.test(line));
  const rootText = lines.slice(rootIndex + 1, nextQdisc === -1 ? lines.length : nextQdisc).join('\n');
  const sent = rootText.match(/^\s*Sent\s+(\d+)\s+bytes\s+(\d+)\s+pkt\s+\(dropped\s+(\d+)\s*,\s*overlimits\s+(\d+)\s+requeues\s+(\d+)\s*\)/m);
  const backlog = rootText.match(/^\s*backlog\s+(\d+)b\s+(\d+)p(?:\s|$)/m);
  return {
    kind,
    sentBytes: sent ? Number(sent[1]) : null,
    sentPackets: sent ? Number(sent[2]) : null,
    backlogBytes: backlog ? Number(backlog[1]) : null,
    backlogPackets: backlog ? Number(backlog[2]) : null,
    drops: sent ? Number(sent[3]) : null,
    overlimits: sent ? Number(sent[4]) : null,
    requeues: sent ? Number(sent[5]) : null,
  };
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1];
}

function makeHealth(state, endedAtMs) {
  const gaps = state.gaps;
  return {
    ifName: state.ifName,
    intervalMs: state.intervalMs,
    samples: state.samples,
    gapMs: {
      p50: nearestRank(gaps, 50),
      p95: nearestRank(gaps, 95),
      max: gaps.length ? Math.max(...gaps) : null,
    },
    cpu: {
      userMs: state.cpu.user / 1000,
      systemMs: state.cpu.system / 1000,
    },
    startedAtMs: state.startedAtMs,
    endedAtMs,
    errors: state.errors,
  };
}

function writeHealth(state, healthFile) {
  const endedAtMs = Date.now();
  const usage = process.cpuUsage(state.cpuStart);
  state.cpu = usage;
  fs.writeFileSync(healthFile, `${JSON.stringify(makeHealth(state, endedAtMs))}\n`);
}

async function run(options) {
  const outPath = outputPath(options.runDir, options.out);
  const healthFile = healthPath(outPath);
  const state = {
    ifName: options.ifName,
    intervalMs: options.intervalMs,
    startedAtMs: Date.now(),
    cpuStart: process.cpuUsage(),
    cpu: { user: 0, system: 0 },
    samples: 0,
    gaps: [],
    errors: [],
    previousNs: null,
    stopping: false,
    finished: false,
  };
  const startedMonotonicNs = process.hrtime.bigint();
  let nextDueNs = startedMonotonicNs;
  const intervalNs = BigInt(Math.round(options.intervalMs * 1e6));

  const stop = () => {
    state.stopping = true;
    if (!state.finished) {
      state.finished = true;
      writeHealth(state, healthFile);
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  while (!state.stopping) {
    const nowNs = process.hrtime.bigint();
    if (nowNs < nextDueNs) {
      const waitMs = Number(nextDueNs - nowNs) / 1e6;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));
      continue;
    }
    nextDueNs += intervalNs;
    if (options.maxMs !== null && Number(nowNs - startedMonotonicNs) / 1e6 >= options.maxMs) {
      stop();
      break;
    }

    try {
      const txBytes = readCounter(options.ifName, 'tx_bytes');
      const rxBytes = readCounter(options.ifName, 'rx_bytes');
      const qdisc = readRootQdisc(options.ifName);
      const monotonicNs = process.hrtime.bigint();
      if (state.previousNs !== null) state.gaps.push(Number(monotonicNs - state.previousNs) / 1e6);
      state.previousNs = monotonicNs;
      const atMs = Date.now();
      const record = {
        atMs,
        atIso: new Date(atMs).toISOString(),
        // Keep monotonicNs as a string so long runs cannot lose nanoseconds to Number rounding.
        monotonicNs: monotonicNs.toString(),
        ifName: options.ifName,
        txBytes,
        rxBytes,
        qdisc,
      };
      fs.appendFileSync(outPath, `${JSON.stringify(record)}\n`);
      state.samples += 1;
      if (state.samples % 100 === 0) writeHealth(state, healthFile);
    } catch (error) {
      state.errors.push({ atMs: Date.now(), message: error instanceof Error ? error.message : String(error) });
    }
    if (options.maxMs !== null && Date.now() - state.startedAtMs >= options.maxMs) stop();
  }
  if (!state.finished) {
    state.finished = true;
    writeHealth(state, healthFile);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await run(parseArgs(process.argv.slice(2)));
    process.exitCode = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
