import { median } from './stats.mjs';
import { ePair, driftVerdict, multiplierVerdict, numericRanges, peaks as nightPeaks } from './night-verdicts.mjs';

const finite = (value) => Number.isFinite(value);
const PLAYBACK_REFUSAL_REASONS = new Set([
  'client-never-began-playback',
  'client-did-not-start',
  'dropped-frames-above-declared-bar',
]);

function unique(values) { return [...new Set(values.filter(Boolean))]; }
function reasonValue(value) { return typeof value === 'string' ? value : value?.reason ?? null; }
function figuresOf(run) { return run?.refusalReport?.figures ?? {}; }
function readingOf(run, name) { return run?.readings?.[name] ?? null; }
function refused(reading) { return !reading || reading.refused === true; }
function peerExchange(entry, run) {
  return entry?.peerExchange ?? run?.manifest?.condition?.peerExchange === true;
}
function tagsOf(entry, run, figures = figuresOf(run)) {
  return entry?.clientTags ?? run?.manifest?.declaredClientTags
    ?? Object.keys(figures.realtimeFactorByClient ?? {});
}

export function night2Validity(entry = {}, run = {}) {
  const reasons = [];
  if (!Number.isInteger(entry.exit)) reasons.push('exit-unobserved');
  const manifest = run.manifest;
  let playbackRefused = false;
  if (manifest === null || manifest === undefined) reasons.push('manifest-missing');
  else if (manifest.status === 'complete') {
    // A complete manifest has the runner's normal terminal state.
  } else if (manifest.status === 'refused') {
    const refusalReasons = Array.isArray(manifest.refusalReasons) ? manifest.refusalReasons.map(reasonValue) : [];
    if (refusalReasons.length > 0 && refusalReasons.every((reason) => PLAYBACK_REFUSAL_REASONS.has(reason))) playbackRefused = true;
    else {
      reasons.push('status:refused');
      for (const reason of refusalReasons) if (reason && !PLAYBACK_REFUSAL_REASONS.has(reason)) reasons.push(`refusal:${reason}`);
    }
  } else {
    reasons.push(`status:${manifest.status ?? 'missing'}`);
    for (const reason of manifest.refusalReasons ?? []) {
      const value = reasonValue(reason);
      if (value) reasons.push(`refusal:${value}`);
    }
  }
  for (const name of ['lab-drift', 'gap-count']) {
    if (refused(readingOf(run, name))) reasons.push(`reader:${name}`);
  }
  if (peerExchange(entry, run) && refused(readingOf(run, 'byte-inventory'))) reasons.push('reader:byte-inventory');
  if (String(entry.condition ?? '').startsWith('13e-k-') && refused(readingOf(run, 'catch-up'))) reasons.push('reader:catch-up');
  return { valid: reasons.length === 0, reasons: unique(reasons), playbackRefused };
}

function floorOf(reading) {
  const floors = (reading?.pairs ?? []).map((pair) => pair?.floorMs).filter(finite);
  return floors.length ? Math.max(...floors) : null;
}

function reference(verdict) { return { ...verdict, label: 'reference', type: 'reference' }; }
function multiplierReference(figures, max) {
  const verdict = multiplierVerdict(figures, max);
  return reference(verdict.status === 'no-multiplier'
    ? { ...verdict, refusal: figures?.hostUploadMultiplierRefusal?.reason ?? null }
    : verdict);
}
function peerReference(value) {
  const verdict = !finite(value) ? { status: 'unestablished', value: null, minimum: 0.6 }
    : { status: value >= 0.6 ? 'met' : 'missed', value, minimum: 0.6 };
  return reference(verdict);
}
function driftReference(value, floorMs, barMs, field) {
  return reference({ ...driftVerdict(value, floorMs, barMs), field, floorMs });
}
function driftReferences(lab) {
  const floorMs = floorOf(lab);
  return {
    median: driftReference(lab?.absMedianMs, floorMs, 40, 'absMedianMs'),
    p99: driftReference(lab?.absP99Ms, floorMs, 100, 'absP99Ms'),
  };
}
function references(record, multiplierBar = 1.5) {
  return { multiplier: multiplierReference(record.figures, multiplierBar), peerFraction: peerReference(record.figures.peerFractionAggregate), ...driftReferences(record.lab) };
}

function baseRecord(entry, run) {
  const validity = night2Validity(entry, run);
  const figures = figuresOf(run);
  const peer = peerExchange(entry, run);
  return {
    directory: entry.directory ?? null,
    condition: entry.condition ?? null,
    valid: validity.valid,
    reasons: validity.reasons,
    playbackRefused: validity.playbackRefused,
    figures,
    lab: readingOf(run, 'lab-drift'),
    bytes: peer ? readingOf(run, 'byte-inventory') : 'not-applicable',
    byteInventory: peer ? readingOf(run, 'byte-inventory') : 'not-applicable',
    gap: readingOf(run, 'gap-count'),
    landings: readingOf(run, 'landings'),
    clocks: readingOf(run, 'event-clocks'),
    catchUp: readingOf(run, 'catch-up'),
    schedule: run?.schedule ?? null,
    peerExchange: peer,
    clientTags: tagsOf(entry, run, figures),
  };
}

function realtimeAndStalls(record) {
  return {
    realtimeFactorByClient: record.figures.realtimeFactorByClient ?? null,
    stallCountByClient: record.figures.stallCountByClient ?? null,
  };
}

function r2Fields(record) {
  const bytes = record.peerExchange ? record.bytes : null;
  const viewers = bytes?.viewers ?? {};
  const tags = record.clientTags;
  const byViewer = (field) => Object.fromEntries(tags.map((tag) => [tag, viewers[tag]?.[field] ?? null]));
  return {
    mediaBytes: bytes?.host?.mediaBytes ?? null,
    copies: bytes?.room?.wholeRunCopies ?? null,
    watchedBytesByClient: byViewer('watchedBytes'),
    prefetchLeftBytesByClient: byViewer('prefetchLeftBytes'),
    uploadBytesByClient: byViewer('uploadBytes'),
    httpBytesByClient: byViewer('httpBytes'),
    p2pBytesByClient: byViewer('p2pBytes'),
    perViewer: Object.fromEntries(tags.map((tag) => [tag, viewers[tag] ?? null])),
  };
}

function readingRecord(record, multiplierBar = 1.5, includeR2 = false) {
  const reading = {
    references: references(record, multiplierBar),
    ...realtimeAndStalls(record),
  };
  if (includeR2) reading.r2 = r2Fields(record);
  return { ...record, reading };
}

function conditionRecords(entries, runs, matcher, build) {
  return entries.filter((entry) => entry.scored !== false && matcher(entry.condition ?? ''))
    .map((entry) => build(entry, runs[entry.directory] ?? {}));
}
function summarize(records, selector = () => ({})) {
  const counts = {};
  for (const record of records) {
    if (record.valid !== true) continue;
    for (const [name, value] of Object.entries(selector(record) ?? {})) {
      const count = counts[name] ?? { valid: 0, met: 0, missed: 0, other: 0 };
      count.valid += 1;
      if (value?.status === 'met') count.met += 1;
      else if (value?.status === 'missed') count.missed += 1;
      else count.other += 1;
      counts[name] = count;
    }
  }
  return { runs: records, counts, ranges: numericRanges(records) };
}

function wRecord(entry, run) { return readingRecord(baseRecord(entry, run), 1.5, true); }
function uRecord(entry, run) { return readingRecord(baseRecord(entry, run), 1.5, true); }
function ndRecord(entry, run) {
  const record = readingRecord(baseRecord(entry, run));
  record.reading.uplinkUtilisationMean = record.figures.uplinkUtilisationMean ?? null;
  record.reading.uplinkUtilisationPeak = record.figures.uplinkUtilisationPeak ?? null;
  return record;
}

function qLabel(record, tag) {
  const noFrameMs = record.gap?.viewers?.[tag]?.noFrameMs;
  const realtime = record.figures.realtimeFactorByClient?.[tag];
  if (!finite(noFrameMs) || !finite(realtime)) return { status: 'unestablished', noFrameMs: noFrameMs ?? null, realtimeFactor: realtime ?? null };
  if (noFrameMs === 0) return { status: 'prevented', noFrameMs, realtimeFactor: realtime };
  if (realtime >= 0.98) return { status: 'recovered', noFrameMs, realtimeFactor: realtime };
  return { status: 'not-recovered-within-observation', noFrameMs, realtimeFactor: realtime };
}
function qArm(record) {
  const schedule = record.schedule;
  const viewers = Object.fromEntries(record.clientTags.map((tag) => [tag, {
    ...qLabel(record, tag),
    farSkips: record.gap?.viewers?.[tag]?.farSkips ?? null,
    heldAheadMs: schedule?.edge?.heldAheadMsByClient?.[tag] ?? null,
  }]));
  return {
    ...record,
    reading: { ...realtimeAndStalls(record), references: references(record),
      schedule: schedule ? {
        dropInForce: schedule.drop?.inForce ?? null,
        riseInForce: schedule.rise?.inForce ?? null,
        edgeReached: schedule.edge?.reached ?? null,
        heldAheadMsByClient: schedule.edge?.heldAheadMsByClient ?? null,
      } : null,
      viewers,
      copies: record.bytes === 'not-applicable' ? null : record.bytes?.room?.wholeRunCopies ?? null,
      peerShare: record.bytes === 'not-applicable' ? null : record.bytes?.room?.peerShare ?? null,
    },
  };
}
function qRecord(entry, run) {
  const record = qArm(baseRecord(entry, run));
  if (record.schedule === null) {
    record.valid = false;
    record.reasons = unique([...record.reasons, 'schedule-missing']);
    record.reading.schedule = null;
  }
  return record;
}

function pairRecords(entries, runs, productCondition, controlCondition, build) {
  const products = entries.filter((entry) => entry.scored !== false && entry.condition === productCondition);
  const controls = entries.filter((entry) => entry.scored !== false && entry.condition === controlCondition);
  const pairs = [];
  for (let index = 0; index < Math.min(products.length, controls.length); index += 1) {
    pairs.push({
      pair: index,
      product: build(products[index], runs[products[index].directory] ?? {}),
      control: build(controls[index], runs[controls[index].directory] ?? {}),
    });
  }
  return pairs;
}
function qTest(entries, runs) {
  const products = conditionRecords(entries, runs, (condition) => condition === '13e-q-product', qRecord);
  const controls = conditionRecords(entries, runs, (condition) => condition === '13e-q-control', qRecord);
  const productEntries = entries.filter((entry) => entry.scored !== false && entry.condition === '13e-q-product');
  const controlEntries = entries.filter((entry) => entry.scored !== false && entry.condition === '13e-q-control');
  const pairs = [];
  for (let index = 0; index < Math.min(productEntries.length, controlEntries.length); index += 1) {
    pairs.push({ pair: index, product: products[index], control: controls[index] });
  }
  const records = [...products, ...controls];
  return { runs: records, pairs, counts: {}, ranges: numericRanges(records) };
}

function tRecord(entry, run) {
  const record = baseRecord(entry, run);
  const pairs = (record.lab?.pairs ?? []).filter((pair) => pair?.left === 'c05' || pair?.right === 'c05')
    .map((pair) => ({ pair: `${pair.left}|${pair.right}`, hiddenClockMs: pair.hiddenClockMs ?? null }));
  const echo = record.figures.echoRoundTripMsP50ByClient ?? {};
  const others = Object.entries(echo).filter(([tag, value]) => tag !== 'c05' && finite(value)).map(([, value]) => value);
  record.reading = {
    hiddenClockMsByPair: pairs,
    hiddenClockMedianMs: median(pairs.map((pair) => pair.hiddenClockMs).filter(finite)),
    offsetSpreadMs: record.lab?.offsetSpreadMs ?? null,
    echoRoundTripMsP50ByClient: { c05: echo.c05 ?? null, othersMedianMs: median(others) },
    predictionMs: 30,
    predictionLabel: 'prediction',
  };
  return record;
}

function kRecord(entry, run) {
  const record = baseRecord(entry, run);
  const catchUp = record.catchUp;
  record.reading = catchUp ? {
    measuredPauseMs: catchUp.measuredPauseMs ?? null,
    gapAfterMs: catchUp.gapAfterMs ?? null,
    timeInto40Ms: catchUp.timeInto40Ms ?? null,
    resolvedBy: catchUp.resolvedBy ?? null,
    skipsDelta: catchUp.skipsDelta ?? null,
    stallCountDelta: catchUp.stallCountDelta ?? null,
    rebuffers: catchUp.stallCountDelta ?? null,
    othersMovedMs: catchUp.othersMovedMs ?? null,
    rateOffUnityMs: catchUp.rate?.offUnityMs ?? null,
  } : null;
  return record;
}

function e10Test(entries, runs) {
  const products = entries.filter((entry) => entry.scored !== false && entry.condition === '13e-e10-product');
  const controls = entries.filter((entry) => entry.scored !== false && entry.condition === '13e-e10-control');
  const pairs = [];
  for (let index = 0; index < Math.min(products.length, controls.length); index += 1) {
    const product = baseRecord(products[index], runs[products[index].directory] ?? {});
    const control = baseRecord(controls[index], runs[controls[index].directory] ?? {});
    const pair = ePair(product, control, index);
    pair.product.references = references(product, 2);
    pair.control.references = references(control, 2);
    pairs.push(pair);
  }
  const validPairs = pairs.filter((pair) => pair.valid);
  const bothPairs = pairs.length === 2 && validPairs.length === 2;
  const copies = bothPairs && validPairs.every((pair) => pair.holds.copies === true);
  const stalls = bothPairs && validPairs.every((pair) => pair.holds.stalls === true);
  const waits = bothPairs && validPairs.every((pair) => pair.holds.waits === true);
  const reasons = [];
  if (validPairs.length !== 2) reasons.push('valid-pairs');
  if (!copies) reasons.push('copies');
  if (!stalls) reasons.push('stalls');
  if (!waits) reasons.push('waits');
  const shown = bothPairs && copies && stalls && waits;
  return {
    pairs,
    validPairs: validPairs.length,
    counts: { copies: validPairs.filter((pair) => pair.holds.copies === true).length,
      stalls: validPairs.filter((pair) => pair.holds.stalls === true).length,
      waits: validPairs.filter((pair) => pair.holds.waits === true).length },
    status: shown ? 'shown' : 'not-shown',
    tradeOff: validPairs.length === 2 && copies && (!stalls || !waits),
    reasons,
    label: shown ? 'host-copy gain shown in these trials' : 'host-copy gain not shown in these trials',
    descriptive: true,
    ranges: numericRanges(pairs),
  };
}

function b2Record(entry, run) {
  const record = baseRecord(entry, run);
  const figures = record.figures;
  const multiplier = multiplierVerdict(figures, null);
  record.reading = {
    multiplier: multiplier.status === 'no-multiplier'
      ? { ...multiplier, refusal: figures.hostUploadMultiplierRefusal?.reason ?? null }
      : multiplier,
    realtimeFactorByClient: figures.realtimeFactorByClient ?? null,
    stallCountByClient: figures.stallCountByClient ?? null,
    noFrameMs: Object.fromEntries(Object.entries(record.gap?.viewers ?? {}).map(([tag, value]) => [tag, value?.noFrameMs ?? null])),
    uplinkUtilisationMean: figures.uplinkUtilisationMean ?? null,
    uplinkUtilisationPeak: figures.uplinkUtilisationPeak ?? null,
    waits: figures.waits ?? null,
    ...(figures.waits === undefined ? { waitsReason: 'not-published' } : {}),
  };
  return record;
}

function peaks(entries, runs) {
  return nightPeaks(entries, runs).map((peak, index) => {
    const entry = entries[index];
    const run = runs[entry.directory] ?? {};
    if (peerExchange(entry, run)) return peak;
    const tags = tagsOf(entry, run, figuresOf(run));
    return { ...peak, viewers: Object.fromEntries(tags.map((tag) => [tag, {
      peakStoredBytes: null, peakReason: 'not-applicable-no-peer-exchange', flagged: false,
    }])) };
  });
}

function testSummary(entries, runs, matcher, build, selector) {
  return summarize(conditionRecords(entries, runs, matcher, build), selector);
}

export function night2Verdicts({ entries = [], runs = {} } = {}) {
  const base = entries.map((entry) => baseRecord(entry, runs[entry.directory] ?? {}));
  const diagnostics = entries.filter((entry) => entry.scored === false)
    .map((entry) => ({ directory: entry.directory ?? null, condition: entry.condition ?? null }));
  const tests = {
    W: testSummary(entries, runs, (condition) => condition === '13e-w-long', wRecord, (record) => record.reading.references),
    U: testSummary(entries, runs, (condition) => condition.startsWith('13e-u-'), uRecord, (record) => record.reading.references),
    Q: qTest(entries, runs),
    T: { runs: conditionRecords(entries, runs, (condition) => condition === '13e-t-skew60', tRecord), counts: {}, ranges: {} },
    K: { runs: conditionRecords(entries, runs, (condition) => condition.startsWith('13e-k-'), kRecord), counts: {}, ranges: {} },
    E10: e10Test(entries, runs),
    ND: testSummary(entries, runs, (condition) => condition === '13e-nd-defaults', ndRecord, (record) => record.reading.references),
    B2: { runs: conditionRecords(entries, runs, (condition) => condition.startsWith('13e-b2-'), b2Record), counts: {}, ranges: {} },
  };
  for (const test of ['T', 'K', 'B2']) tests[test].ranges = numericRanges(tests[test].runs);
  return {
    version: 2,
    entries: base,
    diagnostics,
    validity: Object.fromEntries(base.map((record) => [record.directory, {
      valid: record.valid, reasons: record.reasons, playbackRefused: record.playbackRefused,
    }])),
    tests,
    peaks: peaks(entries, runs),
  };
}

