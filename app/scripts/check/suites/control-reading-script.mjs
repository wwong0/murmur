import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assert, assertEqual, check, skipWithoutResults } from '../harness.mjs';
import { buildControlReadingReport } from '../../control-reading.mjs';

const EDGE_READING = {
  kind: 'control', hostPollCoverage: true, controlArm: 'control-arm',
  criteria: { multiplier: { max: 1.5 } }, published: [], acceptedRunsMin: 2, attemptsMax: 3,
  control: { condition: 'control-arm', peerFractionMin: 0.5 },
};
const CONTROL_READING = {
  kind: 'control', criteria: { multiplier: { max: 1.5 } }, published: [],
  acceptedRunsMin: 1, attemptsMax: 2, control: { condition: 'control-arm', peerFractionMin: 0.5 },
};
const TRAP_READING = {
  kind: 'trap', behindHeldAheadMsBelow: 15_000, reproducedPeerFractionMax: 0.1,
  notReproducedPeerFractionMin: 0.5, scatteredSpreadMsAbove: 4_000,
};

function run(condition, reading, multiplier) {
  return {
    condition, manifest: { regime: { name: condition, reading }, clients: {} },
    outcome: 'complete', publishes: true, finalization: { writeByte: true },
    report: { figures: {
      hostUploadMultiplier: multiplier, peerFractionAggregate: 0.7,
      steadyState: { steady: true, failedLegs: [], legs: {
        utilisation: { value: 0.5, pass: true }, downloadRatio: { pass: true }, realtime: { pass: true },
      } }, control: { holds: { start: { waitMs: 100, cause: 'ready', resumed: true }, seek: null },
        recovery: { start: { result: { recovered: true, recoveryMs: 60_000 } }, seek: null } },
    } },
  };
}

export default async function controlReadingScriptSuite() {
  if (skipWithoutResults('control-reading-script')) return;
  await check('control reading script: a labelled 11a-2 register derives edge arms from retained regimes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-reading-script-'));
    try {
      const conditionsPath = path.join(root, 'conditions.json');
      const registerPath = path.join(root, 'register.json');
      fs.writeFileSync(conditionsPath, JSON.stringify({
        'edge-arm': { name: 'edge-arm', reading: EDGE_READING },
        'control-arm': { name: 'control-arm', reading: CONTROL_READING },
        'trap-seek': { name: 'trap-seek', reading: TRAP_READING },
      }));
      const entries = [run('edge-arm', EDGE_READING, 1.2), run('edge-arm', EDGE_READING, 1.3),
        run('control-arm', CONTROL_READING, 1.1)];
      fs.writeFileSync(registerPath, JSON.stringify({ change: '11a-2', arms: ['edge-arm'], runs: entries }));
      const report = buildControlReadingReport({ registerPath, conditionsPath, entries });
      assertEqual(report.change, '11a-2', 'report keeps the register label');
      assert(report.gain?.['edge-arm'], 'an edge arm is read from the retained regime');
      assertEqual(report.gain['edge-arm'].controlArm, 'control-arm', 'gain names the retained control arm');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('control reading script: a named arm without a retained run is an error', async () => {
    let thrown = null;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-reading-script-missing-'));
    try {
      const conditionsPath = path.join(root, 'conditions.json');
      const registerPath = path.join(root, 'register.json');
      fs.writeFileSync(conditionsPath, JSON.stringify({ 'edge-arm': { name: 'edge-arm', reading: EDGE_READING }, 'trap-seek': { name: 'trap-seek', reading: TRAP_READING } }));
      fs.writeFileSync(registerPath, JSON.stringify({ change: '11a-2', arms: ['edge-arm'], runs: [] }));
      try { buildControlReadingReport({ registerPath, conditionsPath, entries: [] }); } catch (error) { thrown = error; }
      assertEqual(thrown?.message, 'arm-not-in-register:edge-arm', 'the missing arm is named');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
