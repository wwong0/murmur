import fs from 'node:fs';
import path from 'node:path';

import { assert, assertEqual, check } from '../harness.mjs';
import { classifyControlReading } from '../../figures/control-reading.mjs';
import {
  confirmation, labelFaults, registeredDifferences, rereadAcceptance, rulesOf,
} from '../../figures/control-reread.mjs';

const LABELS = {
  build: 'measured on the pre-J1-repair build',
  reading: 're-read post-result on 2026-10-04',
  standing: 'not a registered pass',
};
const READING = {
  kind: 'control', productInputs: false, acceptedRunsMin: 2, attemptsMax: 3,
  criteria: { multiplier: { max: 1.5 }, peerFraction: { min: 0.6 } },
  published: [], control: { condition: 'p2p-scattered', peerFractionMin: 0.5 },
};

function failure(type, index) {
  return { type, tag: `c${String(index).padStart(2, '0')}`, requestId: `req-${index}`,
    originResponseId: `origin-${index}` };
}

function peerReport(responseFailures = [], otherFailures = [], published = true) {
  return {
    figures: { peerChecks: [
      { check: 'response-agreement', passed: responseFailures.length === 0, failures: responseFailures },
      { check: 'segment-sum', passed: otherFailures.length === 0, failures: otherFailures },
      { check: 'peer-id-membership', passed: true, failures: [] },
      { check: 'conservation', passed: true, failures: [] },
    ] },
    publishedByte: { published },
  };
}

function entry(directory, options = {}) {
  const condition = options.condition ?? 'control-five';
  const outcome = options.outcome ?? 'complete';
  const writeByte = options.writeByte ?? outcome === 'complete';
  const liveReasons = options.liveReasons ?? [];
  return {
    directory, condition, outcome, publishes: true, finalization: { writeByte },
    manifest: {
      refusalReasons: liveReasons,
      clients: { c01: { role: 'viewer', buildId: 'build-a', peerId: 'p1' },
        c02: { role: 'viewer', buildId: 'build-a', peerId: 'p2' } },
      topology: { regime: { images: { origin: 'image-origin', client: 'image-client' } },
        boundaries: { start: { readback: { refusals: [] } }, end: { readback: { refusals: [] } } } },
    },
    report: { figures: {
      hostUploadMultiplier: options.multiplier ?? 1.2,
      peerFractionAggregate: options.peerFraction ?? 0.7,
      peerFractionByClient: { c01: options.peerFraction ?? 0.7, c02: options.peerFraction ?? 0.7 },
      steadyState: { steady: true, reason: null, legs: {} },
      control: { holds: { start: null, seek: null }, recovery: { start: null, seek: null }, sweep: [] },
      peerChecks: [],
    }, publishedByte: { published: true } },
  };
}

function controls() {
  return entry('control', { condition: 'p2p-scattered', multiplier: 1.1, peerFraction: 0.8 });
}

function classify(armEntries, reading = READING) {
  return classifyControlReading({ runs: [...armEntries, controls()], reading, armNames: [armEntries[0].condition] });
}

function labelledReport() {
  return {
    ruleSet: { labels: LABELS }, labels: { ...LABELS },
    runs: [{ directory: 'r1', labels: { ...LABELS } }],
    arms: { 'control-five': { labels: { ...LABELS } } },
    confirms: { labels: { ...LABELS } },
    sweep: { positions: [{ labels: { ...LABELS } }] },
    fullUplinkClock: { labels: { ...LABELS }, runs: [{ labels: { ...LABELS } }] },
  };
}

function registeredReport() {
  return {
    runs: [{ directory: 'r1', condition: 'control-five', outcome: 'complete', publishes: true,
      accepted: true, figures: { value: 1, pace: { value: 0.2 } }, publishedByte: { published: true },
      classification: { criteria: { multiplier: { result: 'met', value: 1.2, bar: 1.5, reason: 'steady:utilisation', failedLeg: { leg: 'utilisation' } } } } }],
    arms: {
      'control-five': { reading: 'classified', criteria: { multiplier: { result: 'met', value: 1.2 } },
        criterion: { multiplier: { result: 'met', value: 1.2 } }, runs: [{ directory: 'r1', accepted: true }] },
      'control-ten': { reading: 'No reading', reasons: ['control-unavailable:none'], runs: [] },
    },
    baseline: {},
  };
}

export default async function controlRereadSuite() {
  await check('control reread: excused response failures become accepted', async () => {
    const failures = [failure('host-response-unpaired', 1), failure('host-response-unpaired', 2)];
    const result = rereadAcceptance({ entry: entry('refused-excused', {
      outcome: 'refused', writeByte: false,
      liveReasons: [{ reason: 'peer-check-failed:response-agreement', failures }],
    }), liveReasons: [{ reason: 'peer-check-failed:response-agreement', failures }],
    registeredReport: peerReport(failures), rereadReport: peerReport() });
    assertEqual(result.acceptedAsRegistered, false, 'refused run was not registered as accepted');
    assertEqual(result.acceptedUnderReread, true, 'the two reproduced failures are excused');
  });

  await check('control reread: an unreceived response remains refused by id', async () => {
    const failures = Array.from({ length: 8 }, (_, index) => failure('host-response-unpaired', index + 1));
    failures.push(failure('host-response-unreceived', 9));
    const result = rereadAcceptance({ entry: entry('refused-unreceived', {
      outcome: 'refused', writeByte: false,
      liveReasons: [{ reason: 'peer-check-failed:response-agreement', failures }],
    }), liveReasons: [{ reason: 'peer-check-failed:response-agreement', failures }],
    registeredReport: peerReport(failures), rereadReport: peerReport([failures.at(-1)]) });
    assertEqual(result.acceptedUnderReread, false, 'the unreceived response is not excused');
    assertEqual(result.refusedUnderReread[0].originResponseId, 'origin-9', 'the surviving response id is retained');
  });

  await check('control reread: another live refusal stays named', async () => {
    const reason = { reason: 'required-context-absent:headroom' };
    const result = rereadAcceptance({ entry: entry('refused-context', {
      outcome: 'refused', writeByte: false, liveReasons: [reason],
    }), liveReasons: [reason], registeredReport: peerReport(), rereadReport: peerReport() });
    assertEqual(result.acceptedUnderReread, false, 'a non-response refusal cannot be excused');
    assertEqual(result.refusedUnderReread[0].reason, reason.reason, 'the live refusal is named');
  });

  await check('control reread: unreproduced live failures are explicit', async () => {
    const live = [failure('host-response-unpaired', 1)];
    const result = rereadAcceptance({ entry: entry('refused-not-reproduced', {
      outcome: 'refused', writeByte: false,
      liveReasons: [{ reason: 'peer-check-failed:response-agreement', failures: live }],
    }), liveReasons: [{ reason: 'peer-check-failed:response-agreement', failures: live }],
    registeredReport: peerReport([failure('host-response-unpaired', 2)]), rereadReport: peerReport() });
    assertEqual(result.refusedUnderReread[0].reason, 'live-refusal-not-reproduced', 'registered evidence mismatch is named');
  });

  await check('control reread: disagreeing runs split and do not confirm', async () => {
    const result = classify([entry('met', { multiplier: 1.2 }), entry('failed', { multiplier: 1.8 })]);
    const arm = result.arms['control-five'];
    const confirmed = confirmation({ 'control-five': arm });
    assertEqual(arm.criteria.multiplier.result, 'split', 'one met and one failed run split criterion 2');
    assertEqual(arm.runs.length, 2, 'both disagreeing runs remain listed');
    assertEqual(confirmed.confirmed, false, 'a split criterion cannot confirm');
    assertEqual(confirmed.criterion2Five, 'split', 'criterion 2 five is split');
  });

  await check('control reread: met five and ten criteria confirm', async () => {
    const five = classify([entry('five-a', { multiplier: 1.2 }), entry('five-b', { multiplier: 1.3 })]).arms['control-five'];
    const tenReading = { ...READING, criteria: { multiplier: { max: 2 } } };
    const ten = classify([entry('ten-a', { condition: 'control-ten', multiplier: 1.4 }),
      entry('ten-b', { condition: 'control-ten', multiplier: 1.4 })], tenReading).arms['control-ten'];
    const result = confirmation({ 'control-five': five, 'control-ten': ten });
    assertEqual(result.confirmed, true, 'five multiplier and peer fraction plus ten multiplier all meet');
  });

  await check('control reread: one accepted run is no reading', async () => {
    const arm = classify([entry('only-run')]).arms['control-five'];
    const result = confirmation({ 'control-five': arm });
    assertEqual(arm.reading, 'No reading', 'one run is below the two-run minimum');
    assertEqual(result.criterion2Five, 'no-reading', 'no reading is distinct from failed');
    assertEqual(result.confirmed, false, 'no reading cannot confirm');
  });

  await check('control reread: labels cover every published entry', async () => {
    const report = labelledReport();
    assertEqual(JSON.stringify(labelFaults(report)), JSON.stringify([]), 'all constructed entries carry the rule labels');
    delete report.arms['control-five'].labels.standing;
    assertEqual(JSON.stringify(labelFaults(report)), JSON.stringify(['arms.control-five']), 'an arm label fault names its arm');
    const altered = labelledReport();
    altered.runs[0].labels.reading = 'wrong';
    assertEqual(JSON.stringify(labelFaults(altered)), JSON.stringify(['runs[r1]']), 'a run label fault names its run');
    // Seven labelled entries, all altered alike: they agree with each other, not with the rule set.
    const alike = JSON.parse(JSON.stringify(labelledReport()).replaceAll(LABELS.standing, 'a registered pass'));
    alike.ruleSet.labels = LABELS;
    assertEqual(labelFaults(alike).length, 7, 'labels altered alike all fault against the rule set');
  });

  await check('control reread: registered differences permit only listed repairs', async () => {
    const file = registeredReport();
    const identical = registeredDifferences(file, structuredClone(file));
    const steady = structuredClone(file);
    steady.runs[0].classification.criteria.multiplier.reason = 'steady:capUsed';
    steady.runs[0].classification.criteria.multiplier.failedLeg = { leg: 'capUsed' };
    const added = structuredClone(file);
    added.runs[0].figures.capUsed = { value: 0.4 };
    const newlyRead = structuredClone(file);
    newlyRead.arms['control-ten'] = { reading: 'classified', criteria: { multiplier: { result: 'met' } },
      criterion: { multiplier: { result: 'met' } }, runs: [] };
    assertEqual(identical.length, 0, 'identical reports have no differences');
    assertEqual(registeredDifferences(file, steady).length, 0, 'steady reason and failed leg are permitted');
    assertEqual(registeredDifferences(file, added).length, 0, 'the added cap figure is permitted');
    assertEqual(registeredDifferences(file, newlyRead).length, 0, 'a control-unavailable arm may become read');
  });

  await check('control reread: unpermitted differences name their paths', async () => {
    const file = registeredReport();
    const criterion = structuredClone(file);
    criterion.arms['control-five'].criteria.multiplier.result = 'failed';
    const figure = structuredClone(file);
    figure.runs[0].figures.value = 2;
    const reason = structuredClone(file);
    reason.runs[0].classification.criteria.multiplier.reason = 'threshold:multiplier';
    const criterionDiff = registeredDifferences(file, criterion);
    const figureDiff = registeredDifferences(file, figure);
    const reasonDiff = registeredDifferences(file, reason);
    assertEqual(criterionDiff.length, 1, 'one criterion result gives one difference');
    assertEqual(criterionDiff[0].path, 'arms.control-five.criteria.multiplier.result', 'criterion path is named');
    assertEqual(figureDiff.length, 1, 'one figure value gives one difference');
    assertEqual(figureDiff[0].path, 'runs[r1].figures.value', 'figure path is named');
    assertEqual(reasonDiff.length, 1, 'a non-steady reason is not permitted');
    assertEqual(reasonDiff[0].path, 'runs[r1].classification.criteria.multiplier.reason', 'reason path is named');
  });

  await check('control reread: committed rules union their cap and excusal', async () => {
    const file = path.resolve(process.cwd(), 'scripts/reread/rules-control-reread.json');
    const ruleSet = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = rulesOf(ruleSet);
    assertEqual(result.bars.steadyCapUsedMax, 0.9, 'the cap-used bar is nine tenths');
    assertEqual(JSON.stringify(result.removeBars), JSON.stringify(['steadyPaceBoundMax']), 'the pace bar is removed');
    assertEqual(result.excusals.bytelessCancelledReceipt, true, 'the byteless excusal is in force');
    // The report is checked against the rule set, so the rule set is checked here.
    assertEqual(JSON.stringify(ruleSet.labels), JSON.stringify(LABELS), 'the committed labels are the three registered ones');
  });
}
