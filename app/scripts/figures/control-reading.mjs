import { PRODUCT_ENGINE_WINDOWS } from '../../public/lib/engine-windows.mjs';
import { HEADROOM_DEFAULT } from '../../public/lib/send-pace.mjs';
import { accepted, sameBuild } from './regimes-reading.mjs';

const finite = (value) => Number.isFinite(value);
const CRITERIA = new Set(['multiplier', 'peerFraction', 'startWait', 'seekWait', 'startRecovery', 'seekRecovery']);

function conditionOf(entry) {
  return entry?.condition ?? entry?.manifest?.condition?.name ?? null;
}

function figuresOf(entry) {
  return entry?.report?.figures ?? entry?.figures ?? {};
}

function clientsOf(entry) {
  return entry?.manifest?.clients ?? entry?.clients ?? {};
}

function buildIdsOf(entry) {
  return Object.fromEntries(Object.entries(clientsOf(entry))
    .filter(([, client]) => client?.role !== 'host')
    .map(([tag, client]) => [tag, client?.buildId ?? null])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function imagesOf(entry) {
  return entry?.manifest?.topology?.regime?.images ?? null;
}

function thresholds(reading) {
  if (reading?.kind !== 'control' || !reading.criteria || typeof reading.criteria !== 'object'
    || !Number.isInteger(reading.acceptedRunsMin) || !Number.isInteger(reading.attemptsMax)
    || reading.acceptedRunsMin < 1 || reading.attemptsMax < reading.acceptedRunsMin
    || !reading.control || typeof reading.control.condition !== 'string'
    || !finite(reading.control.peerFractionMin)) {
    throw new Error('control-reading-thresholds-invalid');
  }
  for (const [name, bar] of Object.entries(reading.criteria)) {
    if (!CRITERIA.has(name) || !bar || typeof bar !== 'object') throw new Error(`control-reading-criterion-invalid:${name}`);
    const key = name.endsWith('Wait') || name.endsWith('Recovery') ? 'maxMs' : (name === 'multiplier' ? 'max' : 'min');
    if (!finite(bar[key])) throw new Error(`control-reading-bar-missing:${name}:${key}`);
    if (bar[key] < 0) throw new Error(`control-reading-bar-invalid:${name}:${key}`);
  }
  if (!Array.isArray(reading.published ?? [])) throw new Error('control-reading-published-invalid');
  return reading;
}

function controlOf(entry) {
  return figuresOf(entry).control ?? null;
}

function steadyFailure(steady) {
  if (steady?.steady === true) return null;
  const listed = steady?.failedLegs?.[0];
  const fallback = Object.entries(steady?.legs ?? {}).find(([, leg]) => leg?.pass !== true);
  const raw = listed ?? fallback?.[0] ?? steady?.reason ?? 'steady-unestablished';
  const leg = typeof raw === 'string' ? raw : raw?.leg ?? 'steady-unestablished';
  const rawValue = typeof raw === 'object' ? raw.value : steady?.legs?.[leg]?.value;
  const value = typeof rawValue === 'object' ? rawValue.value ?? null : rawValue ?? null;
  return { leg, value };
}

function result(name, value, bar, outcome, reason = null, extra = {}) {
  return { criterion: name, result: outcome, value: finite(value) ? value : null,
    bar: finite(bar) ? bar : null, ...(reason ? { reason } : {}), ...extra };
}

function steadyCriterion(name, figures, bar) {
  const steady = figures.steadyState;
  const failed = steadyFailure(steady);
  const value = name === 'multiplier' ? figures.hostUploadMultiplier : figures.peerFractionAggregate;
  if (failed) return result(name, value, bar.max ?? bar.min, 'failed', `steady:${failed.leg}`, { failedLeg: failed });
  if (!finite(value)) return result(name, value, bar.max ?? bar.min, 'unestablished', 'value-unavailable');
  const pass = name === 'multiplier' ? value <= bar.max : value >= bar.min;
  return result(name, value, name === 'multiplier' ? bar.max : bar.min, pass ? 'met' : 'failed',
    pass ? null : `threshold:${name}`);
}

function holdCriterion(name, control, bar) {
  const kind = name.startsWith('start') ? 'start' : 'seek';
  const hold = control?.holds?.[kind];
  if (!hold) return result(name, null, bar.maxMs, 'unestablished', `hold-${kind}-unavailable`);
  const value = hold.waitMs;
  if (hold.resumed === false || hold.cause === 'bound') {
    return result(name, value, bar.maxMs, 'failed', hold.cause === 'bound' ? 'resume-bound' : (hold.reason ?? 'hold-never-resumed'));
  }
  if (!finite(value) || hold.cause !== 'ready') {
    return result(name, value, bar.maxMs, 'unestablished', hold.reason ?? 'resume-cause-unestablished');
  }
  return result(name, value, bar.maxMs, value <= bar.maxMs ? 'met' : 'failed', value <= bar.maxMs ? null : 'threshold:wait');
}

function recoveryCriterion(name, control, bar) {
  const kind = name.startsWith('start') ? 'start' : 'seek';
  const recovery = control?.recovery?.[kind]?.result;
  if (!recovery) return result(name, null, bar.maxMs, 'unestablished', `recovery-${kind}-unavailable`);
  if (recovery.recovered === false) return result(name, recovery.recoveryMs, bar.maxMs, 'failed', 'not-recovered');
  if (finite(recovery.recoveryMs)) {
    return result(name, recovery.recoveryMs, bar.maxMs,
      recovery.recoveryMs <= bar.maxMs ? 'met' : 'failed',
      recovery.recoveryMs <= bar.maxMs ? null : 'threshold:recovery');
  }
  if (finite(recovery.recoveryAtMostMs)) {
    return result(name, recovery.recoveryAtMostMs, bar.maxMs,
      recovery.recoveryAtMostMs <= bar.maxMs ? 'met' : 'unestablished',
      recovery.recoveryAtMostMs <= bar.maxMs ? null : 'recovery-bound-exceeds-bar',
      { upperBound: true });
  }
  return result(name, null, bar.maxMs, 'unestablished', recovery.unestablished ? 'recovery-unestablished' : 'recovery-time-unavailable');
}

function publishedHold(name, control) {
  const kind = name.startsWith('start') ? 'start' : 'seek';
  const hold = control?.holds?.[kind];
  return { criterion: name, result: 'observed', value: finite(hold?.waitMs) ? hold.waitMs : null,
    cause: hold?.cause ?? null, resumed: hold?.resumed ?? null, reason: hold?.reason ?? null };
}

function publishedRecovery(name, control) {
  const kind = name.startsWith('start') ? 'start' : 'seek';
  const recovery = control?.recovery?.[kind]?.result;
  return { criterion: name, result: 'observed', value: finite(recovery?.recoveryMs) ? recovery.recoveryMs : null,
    recoveryAtMostMs: finite(recovery?.recoveryAtMostMs) ? recovery.recoveryAtMostMs : null,
    recovered: recovery?.recovered ?? null, unestablished: recovery?.unestablished ?? null };
}

function productInputRefusal(entry, reading) {
  if (reading.productInputs !== true) return null;
  const reasons = [];
  const viewers = Object.entries(clientsOf(entry)).filter(([tag, client]) => client?.role !== 'host' && /^c\d+$/.test(tag));
  for (const [tag, client] of viewers) {
    const windows = client?.engineWindows;
    if (windows?.declared !== null && windows?.declared !== undefined) {
      reasons.push({ reason: 'engine-windows-supplied', tag, detail: windows.declared });
    }
    if (windows?.pageError) reasons.push({ reason: 'engine-windows-invalid', tag, detail: windows.pageError });
    const inForce = windows?.inForce;
    if (!inForce) reasons.push({ reason: 'engine-windows-unavailable', tag });
    else if (JSON.stringify(inForce) !== JSON.stringify(PRODUCT_ENGINE_WINDOWS)) {
      reasons.push({ reason: 'engine-windows-mismatch', tag, expected: PRODUCT_ENGINE_WINDOWS, inForce });
    }
  }
  const host = Object.entries(clientsOf(entry)).find(([, client]) => client?.role === 'host')?.[1]
    ?? entry?.manifest?.host ?? entry?.manifest;
  const headroom = host?.headroom ?? entry?.manifest?.headroom;
  if (headroom?.supplied === true) reasons.push({ reason: 'headroom-fraction-supplied', detail: headroom });
  if (headroom?.pageError) reasons.push({ reason: 'headroom-fraction-invalid', detail: headroom.pageError });
  if (headroom && headroom.available === false) reasons.push({ reason: 'headroom-fraction-unavailable' });
  if (headroom && headroom.supplied !== true && headroom.fraction !== null && headroom.fraction !== undefined
    && headroom.fraction !== HEADROOM_DEFAULT) {
    reasons.push({ reason: 'headroom-fraction-mismatch', expected: HEADROOM_DEFAULT, published: headroom.fraction });
  }
  return reasons.length ? { refused: true, reasons } : null;
}

function topologyPassing(entry) {
  const boundaries = entry?.manifest?.topology?.boundaries;
  const start = boundaries?.start?.readback?.refusals;
  const end = boundaries?.end?.readback?.refusals;
  return Array.isArray(start) && Array.isArray(end) && start.length === 0 && end.length === 0;
}

function peerIdEvidence(entry) {
  const figures = figuresOf(entry);
  if (!finite(figures.peerFractionAggregate) || !figures.peerFractionByClient
    || typeof figures.peerFractionByClient !== 'object') return false;
  const viewers = Object.entries(clientsOf(entry)).filter(([tag, client]) => client?.role !== 'host' && /^c\d+$/.test(tag));
  return viewers.length > 0 && viewers.every(([tag, client]) => typeof client?.peerId === 'string'
    && client.peerId.length > 0 && finite(figures.peerFractionByClient[tag]));
}

function controlSummary(entries, config, acceptedRuns) {
  const candidates = entries.filter((entry) => accepted(entry) && conditionOf(entry) === config.control.condition)
    .map((entry) => {
      const figures = figuresOf(entry);
      const peerFraction = finite(figures.peerFractionAggregate) ? figures.peerFractionAggregate : null;
      const sameBuildAsArm = acceptedRuns.every((run) => sameBuild(entry, run));
      const topology = topologyPassing(entry);
      const peerId = peerIdEvidence(entry);
      const qualifies = peerFraction !== null && peerFraction >= config.control.peerFractionMin
        && sameBuildAsArm && topology && peerId;
      return {
        directory: entry?.directory ?? null,
        condition: conditionOf(entry),
        accepted: true,
        peerFractionAggregate: peerFraction,
        buildIds: buildIdsOf(entry),
        images: imagesOf(entry),
        topologyPassing: topology,
        peerIdEvidence: peerId,
        sameBuildAsArm,
        qualifies,
        ...(qualifies ? {} : { rejected: [
          ...(peerFraction === null ? ['peer-fraction-unavailable'] : peerFraction < config.control.peerFractionMin ? ['peer-fraction-below-floor'] : []),
          ...(!sameBuildAsArm ? ['different-build'] : []),
          ...(!topology ? ['topology-readback-not-passing'] : []),
          ...(!peerId ? ['peer-id-unavailable'] : []),
        ] }),
      };
    });
  const selected = candidates.find((candidate) => candidate.qualifies);
  return { selected: selected ?? null, candidates };
}

function classification(entry, reading) {
  const config = thresholds(reading);
  const figures = figuresOf(entry);
  const productRefusal = productInputRefusal(entry, config);
  if (productRefusal) return {
    directory: entry?.directory ?? null,
    condition: conditionOf(entry),
    accepted: accepted(entry),
    productInput: productRefusal,
    criteria: {},
    published: {},
  };
  const criteria = Object.fromEntries(Object.entries(config.criteria).map(([name, bar]) => {
    if (name === 'multiplier' || name === 'peerFraction') return [name, steadyCriterion(name, figures, bar)];
    if (name.endsWith('Wait')) return [name, holdCriterion(name, controlOf(entry), bar)];
    return [name, recoveryCriterion(name, controlOf(entry), bar)];
  }));
  const published = {};
  for (const name of config.published ?? []) {
    const bar = config.criteria[name];
    if (bar) published[name] = criteria[name];
    else if (name.endsWith('Wait')) published[name] = publishedHold(name, controlOf(entry));
    else if (name.endsWith('Recovery')) published[name] = publishedRecovery(name, controlOf(entry));
    else published[name] = { value: figures[name] ?? null };
  }
  const control = controlOf(entry);
  return {
    directory: entry?.directory ?? null,
    condition: conditionOf(entry),
    accepted: accepted(entry),
    productInput: { refused: false },
    criteria,
    published,
    sweep: config.sweep === true ? (control?.sweep ?? null) : null,
    wait: control?.holds ?? null,
    recovery: control?.recovery ?? null,
  };
}

export function classifyControlRun(entry, reading) {
  return classification(entry, reading);
}

function majorityResult(summaries, name) {
  const values = summaries.map((summary) => summary.classification.criteria[name]?.result).filter(Boolean);
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const winner = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (!winner || winner[1] * 2 <= values.length) {
    return { criterion: name, result: 'split', runs: summaries.map((summary) => ({
      directory: summary.directory, result: summary.classification.criteria[name]?.result ?? 'unestablished',
      value: summary.classification.criteria[name]?.value ?? null,
    })) };
  }
  const chosen = summaries.find((summary) => summary.classification.criteria[name]?.result === winner[0]);
  const selected = chosen?.classification.criteria[name] ?? { criterion: name, result: winner[0], value: null, bar: null };
  return { ...selected, result: winner[0], runCount: winner[1] };
}

function runSummary(entry, reading, state = {}) {
  const base = {
    directory: entry?.directory ?? null,
    condition: conditionOf(entry),
    accepted: accepted(entry),
    outcome: entry?.outcome ?? null,
    publishes: entry?.publishes ?? null,
    finalization: entry?.finalization ?? null,
    buildIds: buildIdsOf(entry),
    images: imagesOf(entry),
  };
  if (entry?.recomputeError) return { ...base, recomputeError: entry.recomputeError };
  if (state.notRead) return { ...base, classification: null, ...state };
  if (!entry?.report?.figures && !entry?.figures) return { ...base, classification: null };
  const classified = classifyControlRun(entry, reading);
  return { ...base, classification: classified, ...state };
}

function canVote(summary) {
  return summary.accepted && summary.classification && summary.classification.productInput?.refused !== true;
}

export function classifyControlReading({ runs = [], reading, armNames = [] } = {}) {
  const config = thresholds(reading);
  const entries = Array.isArray(runs) ? runs : [];
  const conditions = [...new Set([...entries.map(conditionOf), ...armNames]
    .filter((name) => name && name !== config.control.condition))];
  const arms = {};
  for (const condition of conditions) {
    const armEntries = entries.filter((entry) => conditionOf(entry) === condition);
    const summaries = [];
    let stopped = false;
    let acceptedCount = 0;
    for (const entry of armEntries) {
      const isAccepted = accepted(entry);
      if (stopped) {
        summaries.push(runSummary(entry, reading, { notRead: 'arm-stopped' }));
        continue;
      }
      if (armEntries.indexOf(entry) >= config.attemptsMax) {
        summaries.push({ directory: entry?.directory ?? null, condition, accepted: isAccepted,
          outcome: entry?.outcome ?? null, publishes: entry?.publishes ?? null, notRead: 'budget-exceeded' });
        continue;
      }
      const summary = runSummary(entry, reading);
      summaries.push(summary);
      if (!isAccepted || summary.recomputeError || !canVote(summary)) continue;
      acceptedCount += 1;
      const acceptedSummaries = summaries.filter(canVote);
      const names = Object.keys(config.criteria);
      const agreeing = names.every((name) => new Set(acceptedSummaries.map((candidate) => candidate.classification.criteria[name]?.result)).size <= 1);
      if (acceptedCount >= config.acceptedRunsMin && (names.length === 0 || agreeing)) stopped = true;
    }
    const acceptedSummaries = summaries.filter(canVote);
    const control = controlSummary(entries, config, armEntries.filter((entry) => accepted(entry)));
    const criteria = Object.fromEntries(Object.keys(config.criteria).map((name) => [name, majorityResult(acceptedSummaries, name)]));
    const enough = acceptedCount >= config.acceptedRunsMin;
    const hasControl = Boolean(control.selected);
    const reasons = [];
    if (!enough) reasons.push(`accepted-run-count:${acceptedCount}`);
    if (!hasControl) reasons.push(`control-unavailable:${control.candidates.map((candidate) => candidate.directory).join(',') || 'none'}`);
    const noReading = reasons.length > 0;
    const classifiedSweep = config.sweep === true && acceptedSummaries.length > 0
      ? acceptedSummaries.map((summary) => ({ directory: summary.directory, sweep: summary.classification.sweep,
        published: summary.classification.published, wait: summary.classification.wait, recovery: summary.classification.recovery })) : [];
    if (armEntries.length >= config.attemptsMax) stopped = true;
    arms[condition] = {
      condition,
      reading: noReading ? 'No reading' : (config.sweep === true ? 'published' : 'classified'),
      readingKey: noReading ? 'none' : (config.sweep === true ? 'published' : 'classified'),
      acceptedCount,
      stopped,
      attemptsMax: config.attemptsMax,
      runs: summaries,
      criteria: noReading ? {} : criteria,
      criterion: noReading ? {} : criteria,
      published: Object.fromEntries(config.published.map((name) => [name,
        acceptedSummaries.map((summary) => ({ directory: summary.directory,
          ...(summary.classification.published[name] ?? { value: null }) }))])),
      sweep: classifiedSweep,
      control,
      reasons,
    };
  }
  return {
    diagnostic: false,
    criterion: true,
    thresholds: config,
    runs: entries.map((entry) => ({ directory: entry?.directory ?? null, condition: conditionOf(entry),
      accepted: accepted(entry), outcome: entry?.outcome ?? null, publishes: entry?.publishes ?? null,
      recomputeError: entry?.recomputeError ?? null })),
    arms,
  };
}

function regime(entry, fallback = {}) {
  const condition = entry?.manifest?.condition ?? {};
  const qdiscs = condition.qdiscs ?? entry?.manifest?.topology?.qdiscs ?? [];
  const viewerQdiscs = qdiscs.filter((qdisc) => /^c\d+$/.test(qdisc.container ?? '') && qdisc.direction === 'egress');
  return {
    capacityMbps: condition.capacityMbps ?? fallback.capacityMbps ?? null,
    viewerCount: condition.clients ?? fallback.viewerCount ?? null,
    viewerShaping: viewerQdiscs.map((qdisc) => ({ container: qdisc.container, params: qdisc.params ?? null })),
    window: entry?.manifest?.window ? { ...entry.manifest.window,
      durationMs: Number(entry.manifest.window.endMs) - Number(entry.manifest.window.startMs) } : fallback.window ?? null,
  };
}

function staticCell({ multiplier, peerFraction, capacityMbps, viewerCount, viewerShaping, window, reason, source }) {
  return { multiplier: multiplier ?? null, peerFraction: peerFraction ?? null,
    capacityMbps, viewerCount, viewerShaping, window, ...(reason ? { reason } : {}), ...(source ? { source } : {}) };
}

function runCell(entry) {
  if (!entry) return staticCell({ capacityMbps: null, viewerCount: null, viewerShaping: null, window: null, reason: 'no-accepted-run' });
  const figures = figuresOf(entry);
  return staticCell({ multiplier: figures.hostUploadMultiplier, peerFraction: figures.peerFractionAggregate,
    ...regime(entry), source: entry.directory });
}

export function baselineTable({ runs = [], controlRuns = {} } = {}) {
  const acceptedRuns = runs.filter((entry) => accepted(entry));
  const naive7c = staticCell({ multiplier: 1.047, peerFraction: 0.792, capacityMbps: 20, viewerCount: 5,
    viewerShaping: { rate: '10mbit', burst: '32kbit', latency: '400ms' },
    window: { kind: 'steady', durationMs: 180_000 }, source: '7c D6' });
  const trap8aT1 = staticCell({ multiplier: null, peerFraction: 0.006987525487601079, capacityMbps: 10, viewerCount: 5,
    viewerShaping: { rate: '10mbit', burst: '32kbit', latency: '400ms' },
    window: { kind: 'seek', durationMs: 180_000 }, source: '8a D4 T1' });
  return Object.fromEntries(['control-five', 'control-ten'].map((condition) => {
    const arm = controlRuns[condition];
    const baselines = acceptedRuns.filter((entry) => conditionOf(entry) === 'baseline-nop2p-steady');
    const baseline = baselines.find((entry) => arm && sameBuild(entry, arm));
    const sameBuildBaseline = baseline ? runCell(baseline)
      : staticCell({ capacityMbps: null, viewerCount: null, viewerShaping: null, window: null,
        reason: baselines.length ? 'baseline-build-mismatch' : 'no-accepted-run' });
    const cells = { sameBuildBaseline, naive7c, trap8aT1 };
    return [condition, {
      multiplier: Object.fromEntries(Object.entries(cells).map(([name, cell]) => [name, cell.multiplier])),
      peerFraction: Object.fromEntries(Object.entries(cells).map(([name, cell]) => [name, cell.peerFraction])),
      cells,
      control: arm ?? null,
    }];
  }));
}

export { thresholds as validateControlReading, topologyPassing };
