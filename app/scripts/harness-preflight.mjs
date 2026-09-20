// The qdisc preflight: does this runtime's kernel carry `sch_tbf` and
// `sch_netem`, and can a container attach them? It runs before any image is
// built, because a rig that cannot impair is the one fact that ends change 6a
// (design.md D1, OQ3).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { evaluateProbe } from '../harness/preflight-qdisc.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RESULTS_DIR = path.join(APP_DIR, 'results');
const HARNESS_DIR = path.join(APP_DIR, 'harness');

// The image §3 builds both harness images on. The preflight probes the same
// base, so a preflight pass is about the runtime the rig will actually use.
const BASE_IMAGE = 'node:24-bookworm-slim';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : null;
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.resolve(APP_DIR, valueOf('--run-dir') ?? path.join('results', `6a-preflight-${stamp}`));

function prepareRunDir() {
  const relative = path.relative(RESULTS_DIR, runDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`run output directory must be inside ${RESULTS_DIR}: ${runDir}`);
  }
  if (fs.existsSync(runDir)) throw new Error(`run output directory already exists: ${runDir}`);
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  fs.mkdirSync(runDir, { recursive: false });
}

function write(name, body) {
  fs.writeFileSync(path.join(runDir, name), typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'buffer', ...options });
  const decode = (buf) => {
    if (!buf || buf.length === 0) return '';
    // `wsl.exe` writes UTF-16LE; everything else here writes UTF-8.
    const nulls = buf.subarray(0, Math.min(buf.length, 64)).filter((b) => b === 0).length;
    return nulls > 4 ? buf.toString('utf16le') : buf.toString('utf8');
  };
  return {
    command: [command, ...argv].join(' '),
    status: result.status,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
    spawnError: result.error ? String(result.error.message) : null,
  };
}

function parseJsonOrRaw(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function recordRuntime() {
  const version = run('docker', ['version', '--format', '{{json .}}']);
  const info = run('docker', ['info', '--format', '{{json .}}']);
  const wsl = run('wsl.exe', ['-l', '-v']);
  const versionJson = parseJsonOrRaw(version.stdout);
  const infoJson = parseJsonOrRaw(info.stdout);

  const runtime = {
    recordedAt: new Date().toISOString(),
    hostPlatform: process.platform,
    baseImage: BASE_IMAGE,
    dockerVersion: { ...version, parsed: versionJson },
    dockerInfo: { ...info, parsed: infoJson },
    wslList: wsl,
    summary: {
      clientVersion: versionJson?.Client?.Version ?? null,
      serverVersion: versionJson?.Server?.Version ?? null,
      apiVersion: versionJson?.Client?.ApiVersion ?? null,
      kernelVersion: infoJson?.KernelVersion ?? null,
      operatingSystem: infoJson?.OperatingSystem ?? null,
      storageDriver: infoJson?.Driver ?? null,
      cgroupVersion: infoJson?.CgroupVersion ?? null,
      cgroupDriver: infoJson?.CgroupDriver ?? null,
      totalMemoryBytes: infoJson?.MemTotal ?? null,
      cpus: infoJson?.NCPU ?? null,
    },
  };
  write('runtime.json', runtime);
  return runtime;
}

// stdout carries the probe's JSON and nothing else; apt's chatter goes to
// stderr so a noisy install cannot corrupt the evidence.
const IN_CONTAINER = [
  'set -e',
  'apt-get update -qq >&2',
  'apt-get install -y -qq iproute2 kmod >&2',
  'node /harness/preflight-qdisc.mjs',
].join('; ');

function attempt(capabilityArgs, label) {
  const argv = [
    'run', '--rm', ...capabilityArgs,
    '-v', `${HARNESS_DIR.replace(/\\/g, '/')}:/harness:ro`,
    BASE_IMAGE, 'bash', '-c', IN_CONTAINER,
  ];
  const started = Date.now();
  const result = run('docker', argv);
  const probe = parseJsonOrRaw(result.stdout.trim().split('\n').pop() ?? '');
  const evaluation = probe ? evaluateProbe(probe) : null;
  return {
    label,
    dockerArgs: argv,
    elapsedMs: Date.now() - started,
    dockerStatus: result.status,
    dockerStderr: result.stderr,
    probe,
    evaluation,
    ok: Boolean(evaluation?.ok),
  };
}

function main() {
  const daemon = run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (daemon.status !== 0 || !daemon.stdout.trim()) {
    process.stderr.write(`preflight: the Docker daemon is not answering — this is not a module verdict.\n${daemon.stderr.trim()}\n`);
    process.exit(2);
  }

  prepareRunDir();
  const runtime = recordRuntime();

  const attempts = [attempt(['--cap-add=NET_ADMIN'], 'cap-add=NET_ADMIN')];
  if (!attempts[0].ok) attempts.push(attempt(['--privileged'], 'privileged'));
  for (const one of attempts) write(`probe-${one.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`, one);

  const passing = attempts.find((one) => one.ok) ?? null;
  const verdict = {
    recordedAt: new Date().toISOString(),
    baseImage: BASE_IMAGE,
    runtime: runtime.summary,
    capabilityRequired: passing ? passing.label : null,
    attempts: attempts.map((one) => ({
      label: one.label,
      ok: one.ok,
      dockerStatus: one.dockerStatus,
      elapsedMs: one.elapsedMs,
      assertions: one.evaluation?.assertions ?? null,
      observations: one.evaluation?.observations ?? null,
      dockerStderrTail: one.dockerStderr.trim().split('\n').slice(-5).join('\n'),
    })),
    outcome: passing ? (passing.label === 'cap-add=NET_ADMIN' ? 'pass' : 'pass-requires-privileged') : 'oq3',
  };
  write('verdict.json', verdict);

  const relative = path.relative(APP_DIR, runDir);
  if (!passing) {
    const failed = (attempts[0].evaluation?.assertions ?? []).filter((a) => !a.ok).map((a) => a.name);
    process.stderr.write(`preflight REFUSED — sch_netem/sch_tbf could not be attached and read back. OQ3.\n`);
    process.stderr.write(`failed assertions: ${failed.join('; ') || '(the probe did not run — see the retained docker stderr)'}\n`);
    process.stderr.write(`retained: ${relative}\n`);
    process.exit(1);
  }

  process.stdout.write(`preflight PASS — tbf and netem attach and read back under ${passing.label} on ${runtime.summary.kernelVersion}\n`);
  process.stdout.write(`retained: ${relative}\n`);
  if (passing.label !== 'cap-add=NET_ADMIN') {
    process.stdout.write('NOTE: NET_ADMIN was not sufficient and --privileged was required — stop and report before building images.\n');
  }
}

main();
