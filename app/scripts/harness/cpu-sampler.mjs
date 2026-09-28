// Asynchronous docker CPU sampling for a machine-test run.

import fs from 'node:fs';
import path from 'node:path';
import { execFile as childExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(childExecFile);

function append(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function startCpuSampler({ runDir, containers = [], intervalMs = 5_000, now = Date.now,
  execFile = execFileAsync, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  if (!runDir) throw new Error('CPU sampler requires a run directory');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('CPU sampler interval is invalid');
  const file = path.join(runDir, 'cpu-samples.ndjson');
  fs.writeFileSync(file, '');
  const names = [...new Set(containers.filter((name) => typeof name === 'string' && name.length > 0))];
  let inFlight = false;
  let skippedTicks = 0;
  let errors = 0;
  let pending = Promise.resolve();
  const tick = () => {
    if (inFlight) {
      skippedTicks += 1;
      return pending;
    }
    inFlight = true;
    const atMs = now();
    pending = Promise.resolve().then(() => execFile('docker', [
      'stats', '--no-stream', '--format', '{{json .}}', ...names,
    ], { encoding: 'utf8', windowsHide: true })).then(({ stdout = '' }) => {
      for (const line of String(stdout).split(/\r?\n/).filter(Boolean)) {
        try { append(file, { atMs, ...JSON.parse(line), skippedTicks }); }
        catch { errors += 1; }
      }
    }).catch((error) => {
      errors += 1;
      append(file, { kind: 'error', atMs, error: error?.message ?? String(error), skippedTicks });
    }).finally(() => { inFlight = false; });
    return pending;
  };
  const timer = setIntervalFn(tick, intervalMs);
  return {
    file,
    tick,
    async stop() {
      clearIntervalFn(timer);
      await pending;
      append(file, { kind: 'summary', atMs: now(), skippedTicks, errors });
    },
    state() { return { inFlight, skippedTicks, errors }; },
  };
}
