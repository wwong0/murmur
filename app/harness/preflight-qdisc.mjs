// The qdisc preflight's probe and its parsers.
//
// `runProbe()` executes inside a throwaway container and collects evidence
// only — every command with its argv, stdout, stderr and exit code. It asserts
// nothing. `evaluateProbe()` runs on the host against that evidence, so a
// container cannot pass the preflight by reporting its own verdict, and the
// assertions stay where the session that owns the result can read them
// (CONSTRAINTS.md -> Verification, "reachable is not fresh").
//
// Every path and interface name in this file is a container path. `npm run
// check` runs on Windows and never runs this file (CONSTRAINTS.md ->
// Verification, "a path assertion must say which platform it is about").

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PROBE_LINK = 'qdisctest';

// `tbf rate 10mbit burst 32kbit latency 400ms` and `netem loss 5%` are probe
// parameters only. 32 kbit of burst is one 4 KiB token bucket, chosen so the
// read-back is unambiguous, not because it is any condition's burst; the
// numbers the conditions use are declared in `conditions.json`.
export const PROBE_STEPS = [
  { name: 'link-add', argv: ['ip', 'link', 'add', 'name', PROBE_LINK, 'type', 'dummy'] },
  { name: 'link-up', argv: ['ip', 'link', 'set', PROBE_LINK, 'up'] },

  // The discrimination control, and it runs on a link with no root qdisc yet.
  // Run after `tbf` is attached it would fail with "File exists" as readily as
  // with "Unknown qdisc", and two reasons to fail cannot be told apart
  // (CONSTRAINTS.md -> Verification).
  { name: 'control-misspelled-add', argv: ['tc', 'qdisc', 'add', 'dev', PROBE_LINK, 'root', 'tbff', 'rate', '10mbit'] },
  { name: 'control-show', argv: ['tc', 'qdisc', 'show', 'dev', PROBE_LINK] },

  { name: 'tbf-add', argv: ['tc', 'qdisc', 'add', 'dev', PROBE_LINK, 'root', 'tbf', 'rate', '10mbit', 'burst', '32kbit', 'latency', '400ms'] },
  { name: 'tbf-show', argv: ['tc', 'qdisc', 'show', 'dev', PROBE_LINK] },

  { name: 'netem-replace', argv: ['tc', 'qdisc', 'replace', 'dev', PROBE_LINK, 'root', 'netem', 'loss', '5%', 'delay', '0ms'] },
  { name: 'netem-show', argv: ['tc', 'qdisc', 'show', 'dev', PROBE_LINK] },
  { name: 'netem-stats', argv: ['tc', '-s', 'qdisc', 'show', 'dev', PROBE_LINK] },

  { name: 'lsmod', argv: ['sh', '-c', 'lsmod | grep -E "sch_netem|sch_tbf" || true'] },
  { name: 'kernel-release', argv: ['uname', '-r'] },

  { name: 'qdisc-del', argv: ['tc', 'qdisc', 'del', 'dev', PROBE_LINK, 'root'] },
  { name: 'link-del', argv: ['ip', 'link', 'del', PROBE_LINK] },
];

export function runStep(step) {
  const result = spawnSync(step.argv[0], step.argv.slice(1), { encoding: 'utf8' });
  return {
    name: step.name,
    argv: step.argv,
    command: step.argv.join(' '),
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnError: result.error ? String(result.error.message) : null,
  };
}

export function runProbe() {
  const startedAt = new Date().toISOString();
  const steps = [];
  for (const step of PROBE_STEPS) steps.push(runStep(step));
  return { link: PROBE_LINK, startedAt, endedAt: new Date().toISOString(), steps };
}

export function stepByName(probe, name) {
  return probe.steps.find((step) => step.name === name) ?? null;
}

// `qdisc tbf 8001: root refcnt 2 rate 10Mbit burst 4Kb lat 400ms`
export function parseQdiscShow(text) {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('qdisc '));
  if (!line) return null;
  const parts = line.split(/\s+/);
  return { line, kind: parts[1] ?? null, handle: parts[2] ?? null };
}

// ` Sent 0 bytes 0 pkt (dropped 0, overlimits 0 requeues 0)`
// ` backlog 0b 0p requeues 0`
export function parseQdiscStats(text) {
  const body = String(text ?? '');
  const sent = body.match(/Sent\s+(\d+)\s+bytes\s+(\d+)\s+pkt/);
  const counters = body.match(/\(dropped\s+(\d+),\s+overlimits\s+(\d+)\s+requeues\s+(\d+)\)/);
  const backlog = body.match(/backlog\s+(\d+)b\s+(\d+)p/);
  if (!sent || !counters || !backlog) return null;
  return {
    sentBytes: Number(sent[1]),
    sentPackets: Number(sent[2]),
    drops: Number(counters[1]),
    overlimits: Number(counters[2]),
    requeues: Number(counters[3]),
    backlogBytes: Number(backlog[1]),
    backlogPackets: Number(backlog[2]),
  };
}

function assertion(name, ok, detail) {
  return { name, ok, detail };
}

// The host's verdict. The read-back is the proof: `tc qdisc add` exits zero on
// a kernel without the discipline only if it autoloads, so what is asserted is
// the text `tc qdisc show` reports afterwards, never the exit code alone.
export function evaluateProbe(probe) {
  const assertions = [];
  const observations = [];
  const at = (name) => stepByName(probe, name);

  const exitedZero = (name) => {
    const step = at(name);
    return assertion(`${name} exits zero`, Boolean(step) && step.status === 0,
      step ? `status ${step.status}${step.stderr.trim() ? ` · stderr: ${step.stderr.trim()}` : ''}` : 'step did not run');
  };

  assertions.push(exitedZero('link-add'), exitedZero('link-up'));

  const control = at('control-misspelled-add');
  assertions.push(assertion('a misspelled discipline is refused',
    Boolean(control) && control.status !== 0,
    control ? `status ${control.status} · stderr: ${control.stderr.trim()}` : 'step did not run'));

  const controlShow = parseQdiscShow(at('control-show')?.stdout);
  assertions.push(assertion('the refused attachment left no qdisc named tbff',
    Boolean(controlShow) && controlShow.kind !== 'tbff' && controlShow.kind !== 'tbf',
    controlShow ? controlShow.line : 'no qdisc line'));

  assertions.push(exitedZero('tbf-add'));
  const tbf = parseQdiscShow(at('tbf-show')?.stdout);
  assertions.push(assertion('tbf reads back as tbf', Boolean(tbf) && tbf.kind === 'tbf', tbf ? tbf.line : 'no qdisc line'));
  assertions.push(assertion('tbf reads back its declared rate',
    Boolean(tbf) && /\brate\s+10Mbit\b/i.test(tbf.line), tbf ? tbf.line : 'no qdisc line'));

  assertions.push(exitedZero('netem-replace'));
  const netem = parseQdiscShow(at('netem-show')?.stdout);
  assertions.push(assertion('netem reads back as netem', Boolean(netem) && netem.kind === 'netem', netem ? netem.line : 'no qdisc line'));
  assertions.push(assertion('netem reads back its declared loss',
    Boolean(netem) && /\bloss\s+5%/.test(netem.line), netem ? netem.line : 'no qdisc line'));

  const stats = parseQdiscStats(at('netem-stats')?.stdout);
  assertions.push(assertion('the statistics line parses for sent, backlog, drops and overlimits',
    stats !== null, stats ? JSON.stringify(stats) : (at('netem-stats')?.stdout ?? '').trim()));

  assertions.push(exitedZero('qdisc-del'), exitedZero('link-del'));

  // Recorded, not asserted. A WSL2 kernel may carry either discipline built in
  // rather than as a module, in which case `lsmod` is empty and the attachment
  // above still proves the discipline is there. Gating the verdict on `lsmod`
  // would refuse a kernel that works.
  const lsmod = at('lsmod');
  observations.push({
    name: 'sch_netem / sch_tbf appear in lsmod',
    value: (lsmod?.stdout ?? '').trim() || '(none — built in, or not listed)',
  });
  observations.push({ name: 'container kernel release', value: (at('kernel-release')?.stdout ?? '').trim() });

  return { ok: assertions.every((a) => a.ok), assertions, observations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(runProbe())}\n`);
}
