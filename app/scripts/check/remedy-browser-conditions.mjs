// scripts/check/remedy-browser-conditions.mjs
//
// THE NECESSARY CONDITIONS, ENUMERATED ONCE.
//
// `remedy-browser-metrics.mjs` measures; this file judges. Every condition the
// approved contract requires of a stage-A arm is named here exactly once,
// evaluated over the population it is declared on, and returned as a row. The
// arm's `qualified` flag, the four seam proofs and the run's published status
// are all derived from these rows and from nothing else.
//
// The rules the enumeration exists to hold (coordinator verification V1/V2):
//
//  1. A COMPUTED JUDGEMENT THAT NOTHING READS IS NOT A JUDGEMENT. A condition
//     that is measured but excluded from `qualified` lets a run publish a
//     verdict it did not earn, which is exactly what happened to the callback
//     qualification, the playback continuity and the delivery proofs.
//  2. AN UNAVAILABLE OBSERVATION IS NOT A PASS AND NOT A FAILURE. `not-observed`
//     and `unavailable` are their own statuses, carried to the owner by name.
//     `refused` is different again: the evidence needed to decide was absent, so
//     nothing was established and the arm does not qualify.
//  3. A POPULATION IS PART OF THE VERDICT. Each row carries the count it was
//     decided over, so a clause that passed because it inspected nothing is
//     visible rather than indistinguishable from one that inspected everything.
//
// TEST MACHINERY — under scripts/.

/** Every condition, in evaluation order. The list is the contract: a clause
 *  that is not here is not required, and one that is here always reports. */
export const NECESSARY_CONDITIONS = Object.freeze([
  'event-stream-integrity',
  'event-markers-agree',
  'producer-frontier-accounted',
  'acknowledgement-covers-the-analysed-events',
  'single-authority',
  'controller-intake-complete',
  'recorder-intake-complete',
  'collector-healthy',
  'polls-inside-the-window',
  'poll-snapshots-typed',
  'stopping-threshold-ceiling',
  'callback-join-complete',
  'frame-coverage-denominator',
  'callback-qualification',
  'playback-continuity',
  'native-write-readback',
  'native-non-unity-write',
  'dwell-agreement',
  'record-offer-agreement',
  'sampler-input-provenance',
  'build-delivery',
  'client-markers-agree',
]);

const row = (name, status, population, detail = null) => ({ name, status, population, detail });
const met = (name, population, detail = null) => row(name, 'met', population, detail);
const failed = (name, population, detail) => row(name, 'failed', population, detail);
const refused = (name, population, detail) => row(name, 'refused', population, detail);
const unavailable = (name, population, detail) => row(name, 'unavailable', population, detail);

/**
 * One arm's conditions, from the measured blocks.
 *
 * Nothing is recomputed here — every input is a block `analyseArm()` already
 * produced, so a figure quoted in a condition is the same figure the published
 * record shows.
 */
export function necessaryConditions({
  arm,
  buildId,
  stream,
  polls,
  callbacks,
  coverage,
  qualification,
  continuity,
  writes,
  dwell,
  ceiling,
  frontier,
  recordAgreement,
  identity = null,
  factories = {},
  collectorState = null,
  controllerMissed = null,
  recorderMissed = null,
  capturePollCount = 0,
  acknowledgedThrough = null,
  analysedThroughEventId = null,
}) {
  const rows = [];

  rows.push(stream.failures.length === 0
    ? met('event-stream-integrity', { events: stream.events ?? 0 })
    : failed('event-stream-integrity', { events: stream.events ?? 0 }, stream.failures.join(', ')));

  // The arm and build the events themselves carry. This is raw-file evidence and
  // survives a replay; the CDP-side markers below do not.
  const markerFailures = stream.failures.filter((item) => item === 'arm-disagreement' || item === 'build-disagreement');
  rows.push(markerFailures.length === 0
    ? met('event-markers-agree', { arm, buildId, collectors: (stream.collectors ?? []).length })
    : failed('event-markers-agree', { arm, buildId }, markerFailures.join(', ')));

  // THE PRODUCER'S OWN COUNT, NOT THE RECEIVER'S. Contiguous ids prove nothing
  // about events the page numbered after the last one Node collected.
  if (frontier === null || frontier === undefined) {
    rows.push(refused('producer-frontier-accounted', {}, 'no producer frontier was declared for this capture'));
  } else if (frontier.complete) {
    rows.push(met('producer-frontier-accounted', { produced: frontier.produced, delivered: frontier.delivered }));
  } else {
    rows.push(failed('producer-frontier-accounted', { produced: frontier.produced, delivered: frontier.delivered },
      `${frontier.missingCount} produced id(s) were never delivered`));
  }

  // A read is not an acknowledgement; an acknowledgement that does not reach the
  // events being analysed leaves them retrievable but not durably released.
  if (!Number.isFinite(acknowledgedThrough) || !Number.isFinite(analysedThroughEventId)) {
    rows.push(refused('acknowledgement-covers-the-analysed-events', { acknowledgedThrough, analysedThroughEventId },
      'no acknowledgement frontier was recorded'));
  } else if (acknowledgedThrough >= analysedThroughEventId) {
    rows.push(met('acknowledgement-covers-the-analysed-events', { acknowledgedThrough, analysedThroughEventId }));
  } else {
    rows.push(failed('acknowledgement-covers-the-analysed-events', { acknowledgedThrough, analysedThroughEventId },
      'the page was never told the analysed events were durable'));
  }

  const constructionFailures = ['createDriftController', 'createFrameSampler', 'createDriftLog']
    .filter((factory) => (factories[factory] ?? 0) !== 1);
  const authorityOk = polls.complete && constructionFailures.length === 0;
  rows.push(authorityOk
    ? met('single-authority', { polls: polls.rows.length, factories })
    : failed('single-authority', { polls: polls.rows.length, factories },
      [...polls.failures, ...constructionFailures.map((factory) => `construction-count-${factory}`)].join(', ')));

  rows.push(controllerMissed === null
    ? refused('controller-intake-complete', { polls: capturePollCount }, 'a poll read the log without reporting how much it missed')
    : (controllerMissed === 0
      ? met('controller-intake-complete', { polls: capturePollCount, missed: 0 })
      : failed('controller-intake-complete', { polls: capturePollCount, missed: controllerMissed }, 'the controller missed records')));

  rows.push(recorderMissed === null
    ? refused('recorder-intake-complete', {}, 'the recorder intake was never reported')
    : (recorderMissed === 0
      ? met('recorder-intake-complete', { missed: 0 })
      : failed('recorder-intake-complete', { missed: recorderMissed }, 'the recorder missed records')));

  if (collectorState === null) {
    rows.push(refused('collector-healthy', {}, 'no collector state was retained'));
  } else if (collectorState.fatal) {
    rows.push(failed('collector-healthy', { lost: collectorState.lost ?? null }, `collector latched ${collectorState.fatal.reason}`));
  } else if ((collectorState.lost ?? 0) > 0) {
    rows.push(failed('collector-healthy', { lost: collectorState.lost }, 'the collector lost events'));
  } else {
    rows.push(met('collector-healthy', { produced: collectorState.produced ?? null, lost: 0 }));
  }

  rows.push(capturePollCount > 0
    ? met('polls-inside-the-window', { polls: capturePollCount })
    : failed('polls-inside-the-window', { polls: 0, pollEvents: polls.rows.length },
      'the capture window contains no controller poll'));

  rows.push(polls.snapshotFailures.length === 0
    ? met('poll-snapshots-typed', { polls: polls.rows.length })
    : failed('poll-snapshots-typed', { polls: polls.rows.length }, polls.snapshotFailures.join(', ')));

  // At f = 0 an accepted threshold above the ceiling is not a refused contract
  // (`executor-spec.md` C1.3 states the hold for f > 0 only), so it is carried
  // as an observation on a met row instead of counted as a failure.
  const zeroFloorAbove = ceiling.aboveCeilingAtZeroFloor?.length ?? 0;
  const ceilingPopulation = { polls: ceiling.inspected, ceilingMs: ceiling.ceilingMs, aboveCeilingAtZeroFloor: zeroFloorAbove };
  if (ceiling.violations.length > 0) {
    rows.push(failed('stopping-threshold-ceiling', ceilingPopulation,
      `${ceiling.violations.length} poll(s) accepted a floor and a stopping threshold above the ceiling`));
  } else if ((ceiling.undecidable?.length ?? 0) > 0) {
    rows.push(refused('stopping-threshold-ceiling', ceilingPopulation,
      `${ceiling.undecidable.length} poll(s) accepted a threshold above the ceiling without publishing the floor it was accepted under`));
  } else {
    rows.push(met('stopping-threshold-ceiling', ceilingPopulation, zeroFloorAbove === 0
      ? null
      : `${zeroFloorAbove} poll(s) at f = 0 accepted a threshold above the ceiling; those polls cannot count toward a dwell`));
  }

  rows.push(callbacks.complete
    ? met('callback-join-complete', { callbacks: callbacks.rows.length })
    : failed('callback-join-complete', { callbacks: callbacks.rows.length }, callbacks.failures.join(', ')));

  rows.push(coverage.failures.length === 0
    ? met('frame-coverage-denominator', { accepted: coverage.acceptedRecords, expected: coverage.normalizedExpected })
    : failed('frame-coverage-denominator', { accepted: coverage.acceptedRecords }, coverage.failures.join(', ')));

  const failedPredicates = Object.entries(qualification.predicates).filter(([, ok]) => !ok).map(([name]) => name);
  rows.push(qualification.qualified
    ? met('callback-qualification', { callbacks: qualification.callbacks, perSec: qualification.callbacksPerSec })
    : failed('callback-qualification', { callbacks: qualification.callbacks, perSec: qualification.callbacksPerSec },
      `${failedPredicates.join(', ')} did not hold`));

  rows.push(continuity.continuous
    ? met('playback-continuity', { inWindowEvents: continuity.inWindowEvents.length })
    : failed('playback-continuity', { inWindowEvents: continuity.inWindowEvents.length }, continuity.failures.join(', ')));

  rows.push(writes.failures.length === 0
    ? met('native-write-readback', { writes: writes.writes })
    : failed('native-write-readback', { writes: writes.writes }, writes.failures.join(', ')));

  // AN UNAVAILABLE ACTUATOR PROOF IS ITS OWN STATUS. A 20 second window was
  // never required to contain a correction, so its absence is reported to the
  // owner rather than counted against the arm.
  if (writes.nativeWriteProof === 'established') {
    rows.push(met('native-non-unity-write', { nonUnityWrites: writes.nonUnityWrites }));
  } else if (writes.nativeWriteProof === 'unavailable') {
    rows.push(unavailable('native-non-unity-write', { nonUnityWrites: 0 }, 'no non-unity rate was written inside the window'));
  } else {
    rows.push(failed('native-non-unity-write', { nonUnityWrites: writes.nonUnityWrites }, 'a non-unity write did not read back'));
  }

  if (dwell.status === 'agrees') {
    rows.push(met('dwell-agreement', { polls: dwell.polls, elapsedMs: dwell.elapsedMs }));
  } else if (dwell.status === 'not-observed') {
    rows.push(unavailable('dwell-agreement', { polls: capturePollCount }, 'the controller ran and never settled inside the window'));
  } else if (dwell.status === 'refused') {
    rows.push(refused('dwell-agreement', { polls: capturePollCount }, dwell.reason));
  } else {
    rows.push(failed('dwell-agreement', { polls: dwell.polls, elapsedMs: dwell.elapsedMs }, dwell.reason ?? 'the walked interval is shorter than the controller claimed'));
  }

  if (recordAgreement === null || recordAgreement === undefined) {
    rows.push(refused('record-offer-agreement', {}, 'the recorder stream was not supplied to the evaluation'));
  } else if (recordAgreement.agrees) {
    rows.push(met('record-offer-agreement', { records: recordAgreement.records, offers: recordAgreement.acceptedOffers }));
  } else {
    rows.push(failed('record-offer-agreement', { records: recordAgreement.records, offers: recordAgreement.acceptedOffers },
      recordAgreement.differences.join(', ')));
  }

  // A capture taken by a build that did not wrap the sampler's clock, timeline
  // and `now` reads carries a NARROWER provenance claim. That is unavailable
  // evidence, named as such — not a failure of the capture that has it.
  const provenance = callbacks.samplerProvenance ?? { callbacks: 0, withReads: 0, complete: false, inputs: [] };
  if (provenance.complete) {
    rows.push(met('sampler-input-provenance', { callbacks: provenance.callbacks, inputs: provenance.inputs }));
  } else if (provenance.withReads === 0) {
    rows.push(unavailable('sampler-input-provenance', { callbacks: provenance.callbacks, withReads: 0 },
      'this build did not observe the sampler\'s own clock, timeline and now() reads'));
  } else {
    rows.push(failed('sampler-input-provenance', { callbacks: provenance.callbacks, withReads: provenance.withReads },
      'some callbacks recorded the sampler\'s reads and some did not'));
  }

  rows.push(...deliveryConditions({ arm, buildId, identity }));
  return summarise(rows);
}

/**
 * The two conditions that need the CDP-side identity taken before the client was
 * closed. They are `refused` where that identity was not retained, because a
 * delivery nobody recorded is not a delivery anybody proved.
 */
function deliveryConditions({ arm, buildId, identity }) {
  if (identity === null || identity === undefined) {
    return [
      refused('build-delivery', {}, 'no client identity was retained for this arm'),
      refused('client-markers-agree', {}, 'no client identity was retained for this arm'),
    ];
  }
  const deliveries = identity.delivery?.records ?? [];
  const refusals = identity.delivery?.refusals ?? [];
  const deliveryFailures = [];
  if (deliveries.length !== 1) deliveryFailures.push(`${deliveries.length} bundle deliveries were recorded, not one`);
  if (refusals.length > 0) deliveryFailures.push(`${refusals.length} request(s) were refused by the research pattern`);
  if (deliveries.some((record) => record.acknowledged !== true)) deliveryFailures.push('a fulfilment was not acknowledged');
  if (identity.deliveredSha256 === null || identity.deliveredSha256 !== identity.expectedBundleSha256) {
    deliveryFailures.push('the delivered bytes are not the research bundle this arm built');
  }
  const markerFailures = [];
  if (identity.pageBuildId !== buildId) markerFailures.push(`the page reports build ${identity.pageBuildId ?? 'none'}`);
  if (identity.harnessBuildId !== buildId) markerFailures.push(`the harness reports build ${identity.harnessBuildId ?? 'none'}`);
  if (identity.armMarker !== arm) markerFailures.push(`the harness reports arm ${identity.armMarker ?? 'none'}`);
  return [
    deliveryFailures.length === 0
      ? met('build-delivery', { deliveries: deliveries.length, sha256: identity.deliveredSha256 })
      : failed('build-delivery', { deliveries: deliveries.length }, deliveryFailures.join('; ')),
    markerFailures.length === 0
      ? met('client-markers-agree', { arm, buildId })
      : failed('client-markers-agree', { arm, buildId }, markerFailures.join('; ')),
  ];
}

/** The rows, plus the three lists a reader needs without re-deriving them. A
 *  `refused` condition is not a pass: nothing was established. */
function summarise(rows) {
  const named = (status) => rows.filter((item) => item.status === status).map((item) => item.name);
  const missing = NECESSARY_CONDITIONS.filter((name) => !rows.some((item) => item.name === name));
  for (const name of missing) rows.push(refused(name, {}, 'the enumeration did not evaluate this condition'));
  return {
    conditions: rows,
    failed: named('failed'),
    refused: named('refused'),
    unavailable: named('unavailable'),
    qualified: rows.every((item) => item.status === 'met' || item.status === 'unavailable'),
  };
}

/**
 * The four seam proofs, derived from the same rows.
 *
 * They are computed here rather than in the published document, so the value
 * that decides publication and the value a reader sees are one value.
 */
export function seamProofsOf(conditions) {
  const status = (name) => conditions.conditions.find((item) => item.name === name)?.status ?? 'refused';
  const all = (names) => {
    const statuses = names.map(status);
    if (statuses.every((item) => item === 'met')) return 'established';
    if (statuses.some((item) => item === 'failed')) return 'failed';
    return 'refused';
  };
  return {
    buildDelivery: all(['build-delivery', 'client-markers-agree', 'event-markers-agree']),
    singleAuthority: all(['single-authority', 'polls-inside-the-window', 'poll-snapshots-typed']),
    nativeNonUnityWrite: status('native-non-unity-write') === 'unavailable'
      ? 'unavailable'
      : all(['native-non-unity-write', 'native-write-readback']),
    completeObservation: all([
      'event-stream-integrity', 'producer-frontier-accounted', 'acknowledgement-covers-the-analysed-events',
      'controller-intake-complete', 'recorder-intake-complete', 'collector-healthy',
      'callback-join-complete', 'frame-coverage-denominator', 'callback-qualification',
      'playback-continuity', 'stopping-threshold-ceiling', 'record-offer-agreement',
    ]),
  };
}
