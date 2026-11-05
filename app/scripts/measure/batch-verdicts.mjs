const finite = (value) => Number.isFinite(value);

const PLAYBACK_REFUSAL_REASONS = new Set([
  'client-never-began-playback',
  'client-did-not-start',
  'dropped-frames-above-declared-bar',
]);

export function unique(values) { return [...new Set(values.filter(Boolean))]; }

export function figuresOf(run) { return run?.refusalReport?.figures ?? {}; }
export function readingOf(run, name) { return run?.readings?.[name] ?? null; }
export function refused(reading) { return !reading || reading.refused === true; }

function reasonValue(value) {
  return typeof value === 'string' ? value : value?.reason ?? null;
}

// Validity clauses 1 and 2: the exit was observed, and the manifest is complete or refused for playback only.
export function statusValidity(entry = {}, run = {}) {
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
  return { reasons, playbackRefused };
}

export function runValidity(entry = {}, run = {}) {
  const { reasons, playbackRefused } = statusValidity(entry, run);
  for (const name of ['lab-drift', 'byte-inventory', 'gap-count']) {
    if (refused(readingOf(run, name))) reasons.push(`reader:${name}`);
  }
  return { valid: reasons.length === 0, reasons: unique(reasons), playbackRefused };
}

export function driftVerdict(value, floorMs, barMs) {
  if (!finite(value) || !finite(floorMs) || !finite(barMs)) return { status: 'unestablished' };
  if (value + floorMs <= barMs) return { status: 'met', value, floorMs, barMs };
  if (value - floorMs > barMs) return { status: 'missed', value, floorMs, barMs };
  return { status: 'undecidable', value, floorMs, barMs };
}

function failedLegs(steady) {
  if (Array.isArray(steady?.failedLegs)) return steady.failedLegs;
  return Object.entries(steady?.legs ?? {}).filter(([, leg]) => leg?.pass !== true)
    .map(([name, leg]) => ({ leg: name, value: leg }));
}

export function multiplierVerdict(figures = {}, max) {
  const steady = figures?.steadyState;
  if (steady?.steady !== true) return { status: 'no-multiplier', failedLegs: failedLegs(steady) };
  const value = figures?.hostUploadMultiplier;
  if (finite(value) && max === null) return { status: 'reading', value };
  if (!finite(value) || !finite(max)) return { status: 'unestablished', value: finite(value) ? value : null, max };
  return { status: value <= max ? 'met' : 'missed', value, max };
}

export function peerVerdict(value, minimum) {
  if (!finite(value) || !finite(minimum)) return { status: 'unestablished', value: finite(value) ? value : null, minimum };
  return { status: value >= minimum ? 'met' : 'missed', value, minimum };
}

function floorOf(reading) {
  const floors = (reading?.pairs ?? []).map((pair) => pair?.floorMs).filter(finite);
  return floors.length ? Math.max(...floors) : null;
}

export function driftCriterion(reading, field, barMs) {
  const value = reading?.[field];
  const floorMs = floorOf(reading);
  return { ...driftVerdict(value, floorMs, barMs), field, floorMs };
}

function refusalMissed(value) { return { ...value, status: 'missed', reason: 'playback-refused' }; }

function criterionValues(record, playbackRefused) {
  const figures = record.figures;
  const lab = record.lab;
  const c2 = multiplierVerdict(figures, record.multiplierBar);
  const c3 = peerVerdict(figures.peerFractionAggregate, 0.6);
  const c1 = driftCriterion(lab, 'absMedianMs', 40);
  return playbackRefused ? { drift: refusalMissed(c1), multiplier: refusalMissed(c2), peerFraction: refusalMissed(c3) } : { drift: c1, multiplier: c2, peerFraction: c3 };
}

function validRecord(entry, run) {
  const validity = runValidity(entry, run);
  return { directory: entry.directory ?? null, condition: entry.condition ?? null, ...validity,
    figures: figuresOf(run), lab: readingOf(run, 'lab-drift'), bytes: readingOf(run, 'byte-inventory'),
    gap: readingOf(run, 'gap-count'), landings: readingOf(run, 'landings'), clocks: readingOf(run, 'event-clocks') };
}

function aRecord(entry, run, multiplierBar) {
  const record = validRecord(entry, run);
  record.multiplierBar = multiplierBar;
  record.criteria = criterionValues(record, record.playbackRefused);
  record.pass = record.valid && Object.values(record.criteria).every((criterion) => criterion.status === 'met');
  return record;
}

function a10Record(entry, run) {
  const record = readingRecord(entry, run);
  record.reading.multiplier = multiplierVerdict(record.figures, 2);
  return record;
}

function readingRecord(entry, run) {
  const record = validRecord(entry, run);
  const figures = record.figures;
  record.reading = {
    multiplier: multiplierVerdict(figures, null),
    multiplierValue: finite(figures.hostUploadMultiplier) ? figures.hostUploadMultiplier : null,
    steadyState: figures.steadyState ?? null,
    peerFraction: finite(figures.peerFractionAggregate) ? figures.peerFractionAggregate : null,
    medianMs: record.lab?.absMedianMs ?? null,
    p99Ms: record.lab?.absP99Ms ?? null,
    stallCountByClient: figures.stallCountByClient ?? null,
  };
  return record;
}

function bRecord(entry, run) {
  const record = readingRecord(entry, run);
  const figures = record.figures;
  const gap = record.gap;
  record.reading.realtimeFactorByClient = figures.realtimeFactorByClient ?? null;
  record.reading.noFrameMs = Object.fromEntries(Object.entries(gap?.viewers ?? {}).map(([tag, value]) => [tag, value?.noFrameMs ?? null]));
  record.reading.hostMediaBytes = record.bytes?.host?.mediaBytes ?? null;
  if (entry.condition === '13d-b-product-20') {
    record.criteria = { multiplier: record.playbackRefused ? refusalMissed(multiplierVerdict(figures, 1.5)) : multiplierVerdict(figures, 1.5) };
  }
  return record;
}

function coverageFailures(lab) {
  const failures = [];
  for (const pair of lab?.pairs ?? []) {
    const numerator = finite(pair?.missing) && finite(pair?.epochMismatch) ? pair.missing + pair.epochMismatch : null;
    const denominator = lab?.window?.points;
    if (!finite(numerator) || !finite(denominator) || denominator <= 0 || numerator / denominator > 0.05) {
      failures.push(pair?.left && pair?.right ? `${pair.left}|${pair.right}` : 'coverage');
    }
  }
  return failures;
}

function realtimeFailures(figures) {
  return Object.entries(figures?.realtimeFactorByClient ?? {})
    .filter(([, value]) => !finite(value) || value < 0.98).map(([tag]) => tag);
}

function lRecord(entry, run) {
  const record = validRecord(entry, run);
  const drift = driftCriterion(record.lab, 'absP99Ms', 100);
  const realtime = realtimeFailures(record.figures);
  const coverage = coverageFailures(record.lab);
  const reasons = [];
  if (record.playbackRefused) reasons.push('playback-refused');
  if (realtime.length) reasons.push(`realtime:${realtime.join(',')}`);
  if (coverage.length) reasons.push(`coverage:${coverage.join(',')}`);
  let status = 'fail';
  if (!record.valid) status = 'invalid';
  else if (drift.status === 'undecidable' && !realtime.length && !coverage.length && !record.playbackRefused) status = 'undecidable';
  else if (drift.status === 'met' && !realtime.length && !coverage.length && !record.playbackRefused) status = 'pass';
  else if (drift.status === 'missed') reasons.push('drift');
  else if (drift.status === 'unestablished') reasons.push('drift-unestablished');
  record.verdict = { status, drift, realtimeFailures: realtime, coverageFailures: coverage, reasons: unique(reasons) };
  record.pass = status === 'pass';
  return record;
}

function rosterK1(rosterFigure) {
  if (Array.isArray(rosterFigure)) return rosterFigure.find((row) => row?.row === 'K1') ?? null;
  if (rosterFigure?.row === 'K1') return rosterFigure;
  return (rosterFigure?.rows ?? []).find((row) => row?.row === 'K1') ?? null;
}

function joinRecord(entry, run) {
  const record = validRecord(entry, run);
  const join = record.clocks?.join ?? null;
  const k1 = rosterK1(run.rosterFigure);
  const stalls = Object.fromEntries(Object.entries(k1?.intervals ?? {}).map(([tag, interval]) => [tag, interval?.after?.stalls?.length ?? null]));
  record.verdict = {
    entryToFirstFrameMs: join?.entryToFirstFrameMs ?? null,
    firstFrameToInSyncMs: join?.firstFrameToInSyncMs ?? null,
    entryToInSyncMs: join?.entryToInSyncMs ?? null,
    entryUnder2s: finite(join?.entryToInSyncMs) ? join.entryToInSyncMs < 2_000 : false,
    firstFrameUnder2s: finite(join?.firstFrameToInSyncMs) ? join.firstFrameToInSyncMs < 2_000 : false,
    k1: k1 ? { status: k1.status, stalls } : null,
    stalls,
    status: record.valid ? 'reading' : 'invalid',
  };
  return record;
}

function cutRecord(entry, run) {
  const record = validRecord(entry, run);
  const cut = record.clocks?.supplierCut ?? null;
  const exercised = cut?.section === 'readable' && cut.victimVerified === true;
  if (!exercised) {
    record.valid = false;
    record.reasons = unique([...record.reasons, 'cut-not-exercised']);
    record.verdict = { status: 'invalid', reasons: ['cut-not-exercised'], victim: cut?.victim ?? null,
      segment: cut?.selection?.segment ?? null, replacement: cut?.replacement ?? null };
    return record;
  }
  const failures = [];
  for (const [tag, stalls] of Object.entries(cut.stalls ?? {})) {
    if (stalls?.stallCountDelta === null || stalls?.stallCountDelta === undefined) failures.push(`stall-count-unavailable:${tag}`);
    else if (stalls.stallCountDelta !== 0) failures.push(`stall-count:${tag}`);
    if (!Number.isSafeInteger(stalls?.count) || stalls.count !== 0) failures.push(`stalls:${tag}`);
  }
  record.verdict = { status: failures.length ? 'fail' : 'pass', reasons: failures, victim: cut.victim,
    segment: cut.selection?.segment ?? null, replacement: cut.replacement ?? null };
  record.pass = !failures.length;
  return record;
}

function addValues(left, right) { return finite(left) && finite(right) ? left + right : null; }

function landingValues(landings) {
  return Object.fromEntries(['start', 'seek'].map((kind) => {
    const row = landings?.[kind];
    return [kind, row ? { copies: row.hostCopiesSum ?? null, waits: row.waitMs ?? null, stalls: row.stallTotalMs ?? null,
      peerShare30s: row.peerShare30s ?? null, backAheadMs: row.backAheadMs ?? null } : null];
  }));
}

function sumLanding(values, key) { return addValues(values.start?.[key], values.seek?.[key]); }

export function ePair(product, control, index) {
  const p = landingValues(product.landings);
  const c = landingValues(control.landings);
  const pSum = Object.fromEntries(['copies', 'waits', 'stalls'].map((key) => [key, sumLanding(p, key)]));
  const cSum = Object.fromEntries(['copies', 'waits', 'stalls'].map((key) => [key, sumLanding(c, key)]));
  const copies = finite(pSum.copies) && finite(cSum.copies) ? pSum.copies < cSum.copies : null;
  const stalls = finite(pSum.stalls) && finite(cSum.stalls) ? pSum.stalls - cSum.stalls <= 250 : null;
  const waits = finite(pSum.waits) && finite(cSum.waits) ? pSum.waits - cSum.waits <= 125 : null;
  const reasons = [];
  if (copies === null) reasons.push('copies:value-missing');
  if (stalls === null) reasons.push('stalls:value-missing');
  if (waits === null) reasons.push('waits:value-missing');
  return { pair: index, valid: product.valid && control.valid, product: p, control: c,
    sums: { product: pSum, control: cSum }, holds: { copies, stalls, waits }, reasons };
}

function eRecord(entries, runs) {
  const products = entries.filter((entry) => entry.scored !== false && entry.condition === '13d-e-product');
  const controls = entries.filter((entry) => entry.scored !== false && entry.condition === '13d-e-control');
  const pairs = [];
  for (let index = 0; index < Math.min(products.length, controls.length); index += 1) {
    pairs.push(ePair(validRecord(products[index], runs[products[index].directory] ?? {}),
      validRecord(controls[index], runs[controls[index].directory] ?? {}), index));
  }
  const validPairs = pairs.filter((pair) => pair.valid);
  const copies = validPairs.filter((pair) => pair.holds.copies === true).length;
  const stallCount = validPairs.filter((pair) => pair.holds.stalls === true).length;
  const stalls = validPairs.every((pair) => pair.holds.stalls === true);
  const waits = validPairs.filter((pair) => pair.holds.waits === true).length;
  const shown = validPairs.length >= 3 && copies >= 3 && stalls && waits >= 3;
  const reasons = [];
  if (validPairs.length < 3) reasons.push('valid-pairs');
  if (copies < 3) reasons.push('copies');
  if (!stalls) reasons.push('stalls');
  if (waits < 3) reasons.push('waits');
  return { pairs, validPairs: validPairs.length, counts: { copies, stalls: stallCount, waits }, status: shown ? 'shown' : 'not-shown',
    tradeOff: copies >= 3 && (!stalls || waits < 3), reasons,
    label: shown ? 'host-copy gain shown in these trials' : 'host-copy gain not shown in these trials' };
}

function countStatuses(records, selector) {
  const result = {};
  for (const record of records) {
    if (record.valid !== true) continue;
    const criteria = selector(record) ?? {};
    for (const [name, criterion] of Object.entries(criteria)) {
      const count = result[name] ?? { valid: 0, met: 0, missed: 0, other: 0 };
      count.valid += 1;
      if (criterion?.status === 'met') count.met += 1;
      else if (criterion?.status === 'missed') count.missed += 1;
      else count.other += 1;
      result[name] = count;
    }
  }
  return result;
}

export function numericRanges(records) {
  const values = new Map();
  function visit(value, key, directory) {
    if (finite(value)) {
      if (!values.has(key)) values.set(key, {});
      values.get(key)[directory] = value;
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [child, childValue] of Object.entries(value)) visit(childValue, key ? `${key}.${child}` : child, directory);
  }
  for (const record of records) {
    if (record.valid !== undefined && record.valid !== true) continue;
    visit(record, '', record.directory ?? 'unknown');
  }
  const ranges = {};
  for (const [key, byRun] of values) {
    const numbers = Object.values(byRun);
    ranges[key || 'value'] = { min: Math.min(...numbers), max: Math.max(...numbers), n: numbers.length, byRun };
  }
  return ranges;
}

const outcome = (held) => ({ status: held ? 'met' : 'missed' });

function summarize(records, selector) {
  return { runs: records, counts: countStatuses(records, selector), ranges: numericRanges(records) };
}

export function peaks(entries, runs) {
  return entries.map((entry) => {
    const run = runs[entry.directory] ?? {};
    const reading = readingOf(run, 'byte-inventory');
    const viewers = {};
    for (const tag of entry.clientTags ?? run.manifest?.declaredClientTags ?? Object.keys(reading?.viewers ?? {})) {
      const viewer = reading?.viewers?.[tag];
      const peakStoredBytes = finite(viewer?.peakStoredBytes) ? viewer.peakStoredBytes : null;
      const peakReason = viewer?.peakReason ?? (reading?.refused ? `reader-refused:${reading.detail ?? reading.reason}`
        : viewer ? 'peak-unavailable' : 'viewer-missing');
      viewers[tag] = { peakStoredBytes, peakReason, flagged: peakStoredBytes >= 1_000_000_000 || peakReason === 'eviction-possible' };
    }
    return { directory: entry.directory ?? null, viewers };
  });
}

function dRecord(entry, run) {
  const record = readingRecord(entry, run);
  record.reference = { multiplier: multiplierVerdict(record.figures, 1.5), peerFraction: peerVerdict(record.figures.peerFractionAggregate, 0.6),
    median: driftCriterion(record.lab, 'absMedianMs', 40), p99: driftCriterion(record.lab, 'absP99Ms', 100) };
  return record;
}

const named = (name) => (condition) => condition === name;
const prefixed = (prefix) => (condition) => condition.startsWith(prefix);

// One test per key, in the order `verdicts.json` publishes them; a scored entry belongs to the test its condition matches.
function perRun(matches, build, counts) {
  return (entries, runs) => summarize(entries.filter((entry) => entry.scored !== false && matches(entry.condition ?? ''))
    .map((entry) => build(entry, runs[entry.directory] ?? {})), counts);
}

const TESTS = {
  A: perRun(named('13d-a-five'), (entry, run) => aRecord(entry, run, 1.5), (record) => ({ ...record.criteria, pass: outcome(record.pass) })),
  A10: perRun(named('13d-a-ten'), a10Record, (record) => ({ multiplier: record.reading.multiplier })),
  A2: perRun(prefixed('13d-a2-'), readingRecord, () => ({})),
  B: perRun(prefixed('13d-b-'), bRecord, (record) => record.criteria),
  D: perRun(named('13d-d-delay25'), dRecord, () => ({})),
  E: (entries, runs) => {
    const e = eRecord(entries, runs);
    return { ...e, ranges: numericRanges(e.pairs) };
  },
  L: perRun(named('13d-l-loss5'), lRecord,
    (record) => ({ pass: record.verdict.status === 'undecidable' ? { status: 'undecidable' } : outcome(record.pass) })),
  'J-join': perRun(named('13d-j-join'), joinRecord, (record) => ({ entryUnder2s: outcome(record.verdict.entryUnder2s),
    firstFrameUnder2s: outcome(record.verdict.firstFrameUnder2s) })),
  'J-cut': perRun(named('13d-j-cut'), cutRecord, (record) => ({ pass: outcome(record.pass) })),
};

export function batchVerdicts({ entries = [], runs = {} } = {}) {
  const base = entries.map((entry) => validRecord(entry, runs[entry.directory] ?? {}));
  const diagnostics = entries.filter((entry) => entry.scored === false).map((entry) => ({ directory: entry.directory ?? null, condition: entry.condition ?? null }));
  const tests = Object.fromEntries(Object.entries(TESTS).map(([name, test]) => [name, test(entries, runs)]));
  return { version: 1, entries: base, diagnostics, validity: Object.fromEntries(base.map((record) => [record.directory, {
    valid: record.valid, reasons: record.reasons, playbackRefused: record.playbackRefused,
  }])), tests, peaks: peaks(entries, runs) };
}
