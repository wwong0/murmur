// Pure playback qualification figures. The traps are the second clock and the
// plain-line false positive; see 6b design.md D6.

import { MAX_RATE_DEVIATION } from '../../public/lib/drift-controller.mjs';
import { DEFAULT_BARS, MIN_RESIDUAL_RECORDS, steadyCommandStretches, stretchSlopes } from '../drift-figures.mjs';
import { qualifyingSaturatedAndPlateauFits } from '../drift-browser-evidence.mjs';
import { startResidual } from '../start-residual.mjs';
import { FRAMES_PER_START, SLOPE_TOLERANCE } from '../start-timing.mjs';

const finite = (value) => Number.isFinite(value);
const tagsOf = (clients, tags) => Array.isArray(tags) ? tags : Object.keys(clients ?? {});
const startsOf = (client) => client?.starts ?? client?.boundaries?.end?.playback?.starts ?? [];
const recordsOf = (client) => Array.isArray(client?.records) ? client.records : [];

export function startResiduals({ clients = {}, tags, content = {} } = {}) {
  const frameRate = content?.frameRate;
  const frameIntervalMs = finite(frameRate) && frameRate > 0 ? 1000 / frameRate : NaN;
  const startResidualsByClient = {};
  const population = { count: 0, met: 0, missed: 0, other: 0 };
  for (const tag of tagsOf(clients, tags)) {
    const client = clients[tag] ?? {};
    const records = recordsOf(client);
    const starts = startsOf(client);
    startResidualsByClient[tag] = starts.map((start, index) => {
      const nextAfterSeq = starts[index + 1]?.afterSeq ?? Infinity;
      const residual = startResidual({ records, start, nextAfterSeq, frameIntervalMs });
      const row = {
        attemptId: start?.attemptId ?? null,
        status: residual.status,
        signedMedianMs: residual.medianMs,
        count: residual.count,
      };
      population.count += 1;
      if (row.status === 'met') population.met += 1;
      else if (row.status === 'missed') population.missed += 1;
      else population.other += 1;
      return row;
    });
  }
  return { startResidualsByClient, startResidualPopulation: population };
}

function solve(matrix, vector) {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < rows.length; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < rows.length; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (!(Math.abs(rows[pivot][column]) > Number.EPSILON)) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let index = column; index <= rows.length; index += 1) rows[column][index] /= divisor;
    for (let row = 0; row < rows.length; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let index = column; index <= rows.length; index += 1) rows[row][index] -= factor * rows[column][index];
    }
  }
  return rows.map((row) => row.at(-1));
}

function normalFit(points, stepIndex = null) {
  const dimension = stepIndex === null ? 2 : 3;
  const origin = points[0]?.x ?? 0;
  const matrix = Array.from({ length: dimension }, () => Array(dimension).fill(0));
  const vector = Array(dimension).fill(0);
  for (const point of points) {
    const x = point.x - origin;
    const values = stepIndex === null ? [1, x] : [1, x, point.index >= stepIndex ? 1 : 0];
    for (let row = 0; row < dimension; row += 1) {
      vector[row] += values[row] * point.y;
      for (let column = 0; column < dimension; column += 1) matrix[row][column] += values[row] * values[column];
    }
  }
  const coefficients = solve(matrix, vector);
  if (!coefficients) return null;
  let rss = 0;
  for (const point of points) {
    const predicted = coefficients[0] + coefficients[1] * (point.x - origin)
      + (stepIndex === null ? 0 : coefficients[2] * (point.index >= stepIndex ? 1 : 0));
    rss += (point.y - predicted) ** 2;
  }
  return { coefficients, rss };
}

const absent = (reason) => ({ status: 'absent', reason });

export function stepFit({ records, start, nextAfterSeq = Infinity, frameRate } = {}) {
  if (!start || !Number.isSafeInteger(start.afterSeq) || start.afterSeq < 0) return absent('invalid-start');
  if (!Array.isArray(records)) return absent('records-not-array');
  if (!(finite(frameRate) && frameRate > 0)) return absent('invalid-frame-rate');
  const ordered = records
    .filter((record) => record && Number.isSafeInteger(record.seq) && record.seq > start.afterSeq)
    .sort((left, right) => left.seq - right.seq);
  const population = ordered.slice(0, FRAMES_PER_START);
  if (population.length < FRAMES_PER_START) return absent(`fewer-than-${FRAMES_PER_START}-records`);
  if (population.some((record) => record.seq > nextAfterSeq)) return absent('record-after-next-start');
  if (new Set(population.map((record) => record.epochMs)).size > 1) return absent('multiple-epochs');
  const points = population.map((record, index) => ({
    index,
    x: record.displaySharedMs - record.clock?.offsetMs,
    y: record.mediaMs,
  }));
  if (points.some((point) => !finite(point.x) || !finite(point.y))) return absent('non-finite-fit-input');
  let best = null;
  for (let stepIndex = 12; stepIndex <= 60; stepIndex += 1) {
    const fit = normalFit(points, stepIndex);
    const numericalTie = best && fit && fit.rss <= 1e-9 && best.rss <= 1e-9;
    if (fit && (!best || (fit.rss < best.rss && !numericalTie))) best = { ...fit, stepIndex };
  }
  if (!best) return absent('fit-singular');
  const plain = normalFit(points);
  if (!plain) return absent('plain-fit-singular');
  const [, mediaRate, step] = best.coefficients;
  const residualRmsMs = Math.sqrt(best.rss / population.length);
  return {
    status: 'ok',
    mediaRate,
    mediaFrameRateFps: mediaRate * frameRate,
    presentationStepMs: -step,
    stepIndex: best.stepIndex,
    residualRmsMs,
    plainLineSlope: plain.coefficients[1],
    rateDeparture: Math.abs(mediaRate - 1) > SLOPE_TOLERANCE,
  };
}

export function stepFits({ clients = {}, tags, content = {} } = {}) {
  const stepFitsByClient = {};
  for (const tag of tagsOf(clients, tags)) {
    const client = clients[tag] ?? {};
    const starts = startsOf(client);
    stepFitsByClient[tag] = starts.map((start, index) => ({
      attemptId: start?.attemptId ?? null,
      ...stepFit({
        records: recordsOf(client),
        start,
        nextAfterSeq: starts[index + 1]?.afterSeq ?? Infinity,
        frameRate: content?.frameRate,
      }),
    }));
  }
  return { stepFitsByClient };
}

function localDisplay(record) {
  return record?.displaySharedMs - record?.clock?.offsetMs;
}

function playbackUnchanged(disturbance) {
  const before = disturbance?.playbackBefore;
  const after = disturbance?.playbackAfter;
  const fields = ['opens', 'begun', 'retargets'];
  return before && after && fields.every((field) => Object.prototype.hasOwnProperty.call(before, field)
    && Object.prototype.hasOwnProperty.call(after, field) && Object.is(before[field], after[field]));
}

function rateOf(poll) {
  return poll?.controller?.rate ?? poll?.rate;
}

function bandFor(record, polls) {
  if (finite(record?.bandMs)) return record.bandMs;
  const local = localDisplay(record);
  const nearby = polls.filter((poll) => finite(poll?.atMs) && finite(poll?.controller?.bandMs ?? poll?.bandMs))
    .sort((left, right) => Math.abs(left.atMs - local) - Math.abs(right.atMs - local));
  return nearby[0]?.controller?.bandMs ?? nearby[0]?.bandMs ?? NaN;
}

function evidenceBase(records, disturbance, driftLogMissed) {
  return {
    records: records.length,
    driftLogMissed: driftLogMissed ?? null,
    qualifyingSaturated: 0,
    qualifyingPlateau: 0,
    postDisturbanceDrift: false,
    postDisturbanceRate: false,
    epochConsistent: null,
    playbackUnchanged: null,
    disturbanceInjected: disturbance?.injected === true,
  };
}

export function maxRateEvidence({ records = [], polls = [], disturbance, driftLogMissed, bars = DEFAULT_BARS } = {}) {
  const retained = Array.isArray(records) ? records : [];
  const observations = evidenceBase(retained, disturbance, driftLogMissed);
  if (disturbance?.injected !== true) return { ...observations, status: 'failed-precondition', reason: 'not-injected' };
  const startMs = disturbance.playResolvedLocalMs;
  const observationMs = disturbance.observationMs ?? disturbance.declared?.observationMs;
  const endMs = disturbance.pauseCallLocalMs + observationMs;
  if (![startMs, endMs, observationMs].every(finite) || endMs < startMs) {
    return { ...observations, status: 'refused', reason: 'missing-observation-window' };
  }
  const observationRecords = retained.filter((record) => {
    const local = localDisplay(record);
    return finite(local) && local >= startMs && local <= endMs;
  });
  const observationPolls = (Array.isArray(polls) ? polls : []).filter((poll) => finite(poll?.atMs)
    && poll.atMs >= startMs && poll.atMs <= endMs);
  const samples = observationPolls.map((poll) => ({ ...(poll.controller ?? poll), atMs: poll.atMs }));
  const stretches = steadyCommandStretches(samples, bars);
  const fits = stretchSlopes({ stretches, records: observationRecords, bars });
  const { saturatedFits, plateauFits } = qualifyingSaturatedAndPlateauFits({ fits, bars });
  observations.observationRecords = observationRecords.length;
  observations.qualifyingSaturated = saturatedFits.length;
  observations.qualifyingPlateau = plateauFits.length;
  const postEnd = startMs + 2000;
  observations.postDisturbanceDrift = retained.some((record) => {
    const local = localDisplay(record);
    return finite(local) && local >= startMs && local <= postEnd && finite(record.driftMs)
      && finite(bandFor(record, observationPolls)) && record.driftMs < -bandFor(record, observationPolls);
  });
  observations.postDisturbanceRate = observationPolls.some((poll) => poll.atMs >= startMs && poll.atMs <= postEnd
    && rateOf(poll) === 1 + MAX_RATE_DEVIATION);
  const prior = retained.filter((record) => finite(localDisplay(record)) && localDisplay(record) < startMs);
  const observedEpochs = observationRecords.map((record) => record.epochMs);
  const preEpoch = prior.find((record) => finite(record.epochMs))?.epochMs
    ?? observationRecords.find((record) => finite(record.epochMs))?.epochMs;
  observations.epochConsistent = observationRecords.length === 0
    ? null : finite(preEpoch) && observedEpochs.every((epoch) => finite(epoch) && epoch === preEpoch);
  observations.playbackUnchanged = playbackUnchanged(disturbance);
  if (observations.epochConsistent === false) return { ...observations, status: 'refused', reason: 'epoch-revision' };
  if (observations.playbackUnchanged !== true) return { ...observations, status: 'refused', reason: 'playback-state-changed' };
  if (!observations.postDisturbanceDrift || !observations.postDisturbanceRate) {
    return { ...observations, status: 'failed-precondition', reason: 'not-saturated' };
  }
  if (driftLogMissed !== 0) return { ...observations, status: 'not-ok', reason: 'drift-log-missed' };
  if (observationRecords.length < (bars.MIN_RESIDUAL_RECORDS ?? MIN_RESIDUAL_RECORDS)) {
    return { ...observations, status: 'not-ok', reason: 'record-count-below-bar' };
  }
  if (saturatedFits.length === 0) return { ...observations, status: 'not-ok', reason: 'missing-saturated-fit' };
  if (plateauFits.length === 0) return { ...observations, status: 'not-ok', reason: 'missing-plateau-fit' };
  return { ...observations, status: 'ok' };
}

export function maxRateCompletion(results = {}) {
  const required = ['c02', 'c03'];
  const statusByClient = Object.fromEntries(required.map((tag) => [tag, results?.[tag]?.status ?? 'absent']));
  return {
    ok: required.every((tag) => statusByClient[tag] === 'ok'),
    required,
    statusByClient,
  };
}
