import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { evaluateMachineTest } from '../../figures/machine-test.mjs';
import { startCpuSampler } from '../../harness/cpu-sampler.mjs';
import { conditionValidationReason } from '../../harness-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ENTRY = fs.readFileSync(path.join(ROOT, 'app', 'public', 'room.entry.js'), 'utf8');
const DECLARATION = {
  cpuSampleIntervalMs: 5_000,
  pageEvaluationIntervalMs: 250,
  bars: { realtimeMin: 0.98, droppedFrameFractionMax: 0.02, evaluationShortfallMax: 0.01 },
};
const TAGS = ['c01', 'c02'];

function polls(last = 720) {
  return [{ atMs: 0, controller: { polls: 0 } }, { atMs: 180_000, controller: { polls: last } }];
}

function fixture({ utilisation = 0.3, realtime = 1, dropped = 0, pollCount = 720, refusalReport = null,
  attemptHistory = [] } = {}) {
  return {
    recompute: {
      condition: { machineTest: DECLARATION, bars: { steadyUtilisationMax: 0.90 } },
      window: { startMs: 0, endMs: 180_000 },
      clients: Object.fromEntries(TAGS.map((tag) => [tag, { polls: polls(pollCount), peerRecords: [] }])),
      figures: {
        uplinkUtilisationMean: utilisation,
        realtimeFactorByClient: Object.fromEntries(TAGS.map((tag) => [tag, realtime])),
        droppedFrameFractionByClient: Object.fromEntries(TAGS.map((tag) => [tag, dropped])),
      },
      cpuSamples: TAGS.concat('origin').map((Name) => ({ Name, CPUPerc: '2.00%', atMs: 1 })),
      cpuSampleFile: 'cpu-samples.ndjson',
    },
    refusalReport,
    attemptHistory,
  };
}

function verdict(options = {}) {
  const input = fixture(options);
  return evaluateMachineTest(input);
}

export default async function machineTestSuite() {
  await check('machine test: dropped frames are resource, not a refusal', async () => {
    const result = verdict({ dropped: 0.05, refusalReport: {
      refused: true,
      reasons: [{ reason: 'dropped-frames-above-declared-bar', tag: 'c01' }],
    } });
    assertEqual(result.availability, 'unavailable', 'dropped-frame run is unavailable');
    assertEqual(result.reason, 'resource', 'dropped frames name resource');
    assertEqual(JSON.stringify(result.resourceClients), JSON.stringify(['c01', 'c02']), 'resource viewers are named');
  });

  await check('machine test: slow playback alone leaves cause unestablished', async () => {
    const result = verdict({ realtime: 0.90 });
    assertEqual(result.availability, 'unavailable', 'slow playback is unavailable');
    assertEqual(result.reason, 'cause-not-established', 'slow playback alone names no cause');
    assertEqual(result.resourceClients.length, 0, 'slow playback has no resource viewers');
  });

  await check('machine test: a full link wins over a slow viewer', async () => {
    const result = verdict({ utilisation: 0.97, realtime: 0.90 });
    assertEqual(result.availability, 'unavailable', 'full-link run is unavailable');
    assertEqual(result.reason, 'link', 'full link names link');
  });

  await check('machine test: every declared bar gives available', async () => {
    const result = verdict();
    assertEqual(result.availability, 'available', 'all bars pass');
    assertEqual(result.reason, null, 'available run has no unavailability reason');
  });

  await check('machine test: two refused attempts name instrument', async () => {
    const refusal = { refused: true, reasons: [{ reason: 'client-never-began-playback', tag: 'c01' }] };
    const result = verdict({ refusalReport: refusal, attemptHistory: [refusal] });
    assertEqual(result.attempt, 'refused', 'refused attempt is marked');
    assertEqual(result.availability, 'unavailable', 'two refused attempts are unavailable');
    assertEqual(result.reason, 'instrument', 'two refusals name instrument');
    assertEqual(result.refusalAttempts, 2, 'both refusals are counted');
  });

  await check('machine test: page evaluation shortfall is a resource verdict', async () => {
    const result = verdict({ pollCount: 700 });
    assertNear(result.evaluationShortfallByClient.c01, 20 / 720, 1e-12, '700 of 720 evaluations is 0.028 shortfall');
    assertEqual(result.reason, 'resource', 'evaluation shortfall names resource');
  });

  await check('machine test: sampler skips an in-flight asynchronous tick', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-sampler-'));
    let release;
    let calls = 0;
    const fakeExecFile = () => {
      calls += 1;
      return new Promise((resolve) => { release = () => resolve({ stdout: '{"Name":"origin","CPUPerc":"2.00%"}\n' }); });
    };
    try {
      const sampler = startCpuSampler({ runDir, containers: ['origin'], intervalMs: 5,
        execFile: fakeExecFile, setIntervalFn: () => 1, clearIntervalFn: () => {} });
      const first = sampler.tick();
      await Promise.resolve();
      sampler.tick();
      assertEqual(calls, 1, 'sampler does not overlap docker stats calls');
      assertEqual(sampler.state().skippedTicks, 1, 'sampler counts skipped ticks');
      release();
      await first;
      await sampler.stop();
      const lines = fs.readFileSync(path.join(runDir, 'cpu-samples.ndjson'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
      assertEqual(lines.at(-1).skippedTicks, 1, 'sampler writes skipped count');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  await check('machine test: declaration pins the page interval literal', async () => {
    const literal = ENTRY.match(/setInterval\(tickPlayback,\s*(\d+)\)/)?.[1];
    assertEqual(literal, String(DECLARATION.pageEvaluationIntervalMs), 'condition interval equals room entry interval');
    assertEqual(conditionValidationReason({ ...fixture().recompute.condition }), null, 'machine declaration validates');
    assert(conditionValidationReason({ ...fixture().recompute.condition, machineTest: { ...DECLARATION, pageEvaluationIntervalMs: 125 } }) === 'machine-test-invalid', 'wrong page interval is refused');
  });
}
