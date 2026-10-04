import { assert, assertEqual, check } from '../harness.mjs';
import * as controlScript from '../../control-reading.mjs';
import * as controlReading from '../../figures/control-reading.mjs';

const TRAP_READING = {
  kind: 'trap', behindHeldAheadMsBelow: 15_000, reproducedPeerFractionMax: 0.1,
  notReproducedPeerFractionMin: 0.5, scatteredSpreadMsAbove: 4_000,
  acceptedRunsMin: 2, attemptsMax: 3, control: { condition: 'p2p-scattered', peerFractionMin: 0.5 },
};
const CONTROL_READING = {
  kind: 'control', productInputs: false, acceptedRunsMin: 1, attemptsMax: 2,
  criteria: { multiplier: { max: 1.5 } }, control: { condition: 'p2p-scattered', peerFractionMin: 0.5 },
};

function baseFigures(steadyState) {
  return { hostUploadMultiplier: 1.2, peerFractionAggregate: 0.7,
    peerFractionByClient: { c01: 0.7, c02: 0.7, c03: 0.7 }, steadyState };
}

function run(steadyState, overrides = {}) {
  return {
    directory: overrides.directory ?? 'run', condition: overrides.condition ?? 'control-five',
    outcome: 'complete', publishes: true, finalization: { writeByte: true },
    manifest: { clients: { c01: { role: 'viewer' }, c02: { role: 'viewer' }, c03: { role: 'viewer' } } },
    report: { figures: { ...baseFigures(steadyState), ...(overrides.figures ?? {}) } },
  };
}

function failedLeg(steady) {
  return typeof controlReading.steadyFailure === 'function' ? controlReading.steadyFailure(steady) : null;
}

function trapClass(entry, condition = { seek: {}, reading: TRAP_READING }) {
  return typeof controlScript.trapClassForRun === 'function'
    ? controlScript.trapClassForRun(entry, condition, TRAP_READING) : null;
}

function positions(runs, conditions) {
  return typeof controlScript.sweepPositions === 'function'
    ? controlScript.sweepPositions(runs, conditions) : null;
}

export default async function controlReadingRepairsSuite() {
  await check('control reading repairs: a per-viewer failed leg publishes only c03', async () => {
    const steady = { steady: false, reason: 'steady-state-download-ratio', legs: {
      downloadRatio: { byClient: { c01: 1, c02: 1, c03: 0.931 }, bars: { min: 0.95, max: 1.25 }, pass: false },
    } };
    const failed = failedLeg(steady);
    assertEqual(failed?.leg, 'downloadRatio', 'download ratio reason names its leg');
    assertEqual(failed?.value, null, 'per-viewer leg has no scalar value');
    assertEqual(JSON.stringify(failed?.viewers), JSON.stringify([{ tag: 'c03', value: 0.931 }]),
      'only c03 is outside the ratio bars');
    const result = controlReading.classifyControlRun(run(steady), CONTROL_READING);
    assertEqual(JSON.stringify(result.criteria.multiplier.failedLeg.viewers), JSON.stringify([{ tag: 'c03', value: 0.931 }]),
      'classification publishes the per-viewer failure');
  });

  await check('control reading repairs: pace failure wins before download ratio', async () => {
    const steady = { steady: false, reason: 'steady-state-pace-bound', legs: {
      paceBound: { value: 0.25, pass: false },
      downloadRatio: { byClient: { c01: 1, c02: 1, c03: 0.931 }, bars: { min: 0.95, max: 1.25 }, pass: false },
    } };
    const failed = failedLeg(steady);
    assertEqual(failed?.leg, 'paceBound', 'pace reason names its leg');
    assertEqual(failed?.value, 0.25, 'pace value is retained');
    const result = controlReading.classifyControlRun(run(steady), CONTROL_READING);
    assertEqual(result.criteria.multiplier.failedLeg.value, 0.25, 'pace value reaches classification');
  });

  await check('control reading repairs: a realtime failure publishes the viewer below the minimum', async () => {
    // The realtime bar is a minimum: 0.97 is below 0.98, 1 and 0.99 are not.
    const steady = { steady: false, reason: 'steady-state-realtime', legs: {
      realtime: { byClient: { c01: 1, c02: 0.97, c03: 0.99 }, bar: 0.98, pass: false },
    } };
    assertEqual(JSON.stringify(failedLeg(steady)), JSON.stringify({ leg: 'realtime', value: null,
      viewers: [{ tag: 'c02', value: 0.97 }] }), 'only c02 is below the realtime minimum');
  });

  await check('control reading repairs: an unknown or missing reason is unestablished', async () => {
    for (const steady of [undefined, { steady: false, reason: 'another-reason', legs: { paceBound: { value: 0.25, pass: false } } }]) {
      assertEqual(JSON.stringify(failedLeg(steady)), JSON.stringify({ leg: 'steady-unestablished', value: null }),
        'no leg is guessed from object order');
    }
  });

  await check('control reading repairs: a collapsed seek run publishes T1', async () => {
    const entry = run({ steady: true, legs: [] }, { condition: 'control-seek', figures: {
      peerFractionAggregate: 0.055, heldAheadMsRoomMedian: 1_947, positionSpreadMsMedian: 1_000,
    } });
    const result = trapClass(entry);
    assertEqual(result?.key, 'T1', 'collapsed seek class is T1');
    assertEqual(result?.class, 'reproduced', '1 947 ms is behind 15 000 ms and 0.055 is at most 0.10');
    assertEqual(result?.accepted, true, 'trap class carries acceptance');
    const missing = trapClass(run({ steady: true, legs: [] }, { condition: 'control-seek',
      figures: { peerFractionAggregate: 0.055, positionSpreadMsMedian: 1_000 } }));
    assertEqual(JSON.stringify(missing), JSON.stringify({ key: null,
      reason: 'trap-reading-value-invalid:run:heldAheadMsRoomMedian' }), 'a missing figure is no class, with its reason');
  });

  await check('control reading repairs: sweep positions include numeric, seek-default and unpaced fractions', async () => {
    const conditions = [
      { name: 'sweep-070', headroomFraction: 0.7, reading: { kind: 'control', sweep: true } },
      { name: 'sweep-095', headroomFraction: 0.95, reading: { kind: 'control', sweep: true } },
      { name: 'sweep-unpaced', headroomFraction: 'unpaced', reading: { kind: 'control', sweep: true } },
      { name: 'control-seek', seek: {}, reading: { kind: 'control', sweep: false } },
    ];
    const runs = conditions.map((condition) => ({ condition: condition.name, directory: condition.name,
      classification: { accepted: true, wait: { start: null }, recovery: { start: null } },
      figures: { control: { sweep: [{ window: { startMs: 0, endMs: 60_000 } }] } } }));
    const result = positions(runs, conditions);
    assertEqual(JSON.stringify(result?.map((entry) => entry.fraction)), JSON.stringify([0.7, 0.85, 0.95, 'unpaced']),
      'positions sort numeric fractions then unpaced');
    assertEqual(result?.find((entry) => entry.fraction === 0.85).runs[0].directory, 'control-seek',
      'seek control fills the default position');
    assertEqual(result?.find((entry) => entry.fraction === 0.85).runs[0].sweep[0].window.endMs, 60_000,
      'seek position carries its sweep spans');
  });

  await check('control reading repairs: trap bars must match trap-seek', async () => {
    let thrown = null;
    try {
      trapClass(run({ steady: true }, { condition: 'control-seek' }), {
        seek: {}, reading: { ...TRAP_READING, scatteredSpreadMsAbove: 4_001 },
      });
    } catch (error) { thrown = error; }
    assertEqual(thrown?.message, 'trap-bars-mismatch:control-seek', 'trap mismatch names the condition');
  });
}
