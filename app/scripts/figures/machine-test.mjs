// Pure verdicts for the ten-peer machine test.

const finite = (value) => Number.isFinite(value);
const DROPPED_REASON = 'dropped-frames-above-declared-bar';

function tagsOf(recompute) {
  return recompute.tags
    ?? recompute.condition?.clientTags
    ?? Object.keys(recompute.clients ?? recompute.figures?.realtimeFactorByClient ?? {});
}

function reasonOf(entry) {
  return typeof entry === 'string' ? entry : entry?.reason;
}

function refusalEntries(report) {
  return report?.reasons ?? report?.refusal?.reasons ?? report?.refusals ?? [];
}

function substantiveRefusals(report) {
  const source = refusalEntries(report);
  const entries = source.filter((entry) => !reasonOf(entry)?.startsWith(DROPPED_REASON));
  const hasReasonList = Array.isArray(report?.reasons) || Array.isArray(report?.refusal?.reasons)
    || Array.isArray(report?.refusals);
  return entries.length || hasReasonList || report?.refused !== true ? entries : [{ reason: 'refused' }];
}

function pollsFor(recompute, tag) {
  return recompute.clients?.[tag]?.polls ?? [];
}

function evaluationShortfall(recompute, tag, intervalMs) {
  const polls = pollsFor(recompute, tag).filter((poll) => finite(poll?.atMs));
  const window = recompute.window;
  const inWindow = polls.filter((poll) => poll.atMs >= window.startMs && poll.atMs <= window.endMs);
  if (inWindow.length < 2 || !finite(window.endMs - window.startMs)) return null;
  const first = Number(inWindow[0]?.controller?.polls);
  const last = Number(inWindow.at(-1)?.controller?.polls);
  const expected = (window.endMs - window.startMs) / intervalMs;
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first || !(expected > 0)) return null;
  return Math.max(0, 1 - (last - first) / expected);
}

function sourceBytes(recompute, tag) {
  const records = recompute.clients?.[tag]?.peerRecords ?? recompute.peerRecords?.[tag] ?? [];
  const bySource = {};
  for (const record of records) {
    if (record?.source !== 'p2p' && record?.kind !== 'peer') continue;
    const source = record.sourcePeer ?? record.peerId ?? record.from ?? 'unknown';
    const bytes = Number(record.bytes ?? record.lengthBytes ?? 0);
    if (finite(bytes) && bytes >= 0) bySource[source] = (bySource[source] ?? 0) + bytes;
  }
  return bySource;
}

function parseCpu(value) {
  if (typeof value === 'number') return value;
  const parsed = Number.parseFloat(String(value ?? ''));
  return finite(parsed) ? parsed : null;
}

function cpuSummary(recompute) {
  const samples = Array.isArray(recompute.cpuSamples) ? recompute.cpuSamples : [];
  const byContainer = {};
  let skippedTicks = 0;
  let errors = 0;
  for (const sample of samples) {
    skippedTicks = Math.max(skippedTicks, Number(sample?.skippedTicks) || 0);
    if (sample?.kind === 'summary') {
      errors += Number(sample.errors) || 0;
      continue;
    }
    if (sample?.kind === 'error') { errors += 1; continue; }
    const name = sample?.Name ?? sample?.name ?? sample?.container;
    const value = parseCpu(sample?.CPUPerc ?? sample?.cpuPercent ?? sample?.cpu);
    if (typeof name !== 'string' || !finite(value)) continue;
    byContainer[name] ??= [];
    byContainer[name].push(value);
  }
  const summary = Object.fromEntries(Object.entries(byContainer).map(([name, values]) => {
    const ordered = [...values].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    const median = ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
    return [name, { maximum: Math.max(...values), median, samples: values.length }];
  }));
  return { file: recompute.cpuSampleFile ?? 'cpu-samples.ndjson', skippedTicks, errors, byContainer: summary };
}

function attemptReports(attemptHistory, current) {
  const history = Array.isArray(attemptHistory) ? attemptHistory : [];
  return [...history, current].filter((report) => report && typeof report === 'object');
}

export function evaluateMachineTest({ recompute = {}, refusalReport = null, attemptHistory = [] } = {}) {
  const condition = recompute.condition ?? {};
  const declaration = condition.machineTest ?? recompute.machineTest ?? {};
  const bars = declaration.bars ?? {};
  const utilisationBar = condition.bars?.steadyUtilisationMax ?? bars.steadyUtilisationMax;
  if (!finite(utilisationBar)) throw new Error('machine-test utilisation bar is not declared');
  const tags = tagsOf(recompute);
  const currentRefusals = substantiveRefusals(refusalReport);
  const refusedAttempts = attemptReports(attemptHistory, refusalReport)
    .map(substantiveRefusals).filter((entries) => entries.length > 0);
  const refusals = refusedAttempts.flat();
  const figures = recompute.figures ?? recompute;
  const shortfallByClient = figures.evaluationShortfallByClient
    ?? Object.fromEntries(tags.map((tag) => [tag,
      evaluationShortfall(recompute, tag, declaration.pageEvaluationIntervalMs ?? 250)]));
  const realtime = figures.realtimeFactorByClient ?? {};
  const dropped = figures.droppedFrameFractionByClient ?? {};
  const utilisation = figures.uplinkUtilisationMean;
  const barsByClient = Object.fromEntries(tags.map((tag) => [tag, {
    realtime: { value: realtime[tag] ?? null, bar: bars.realtimeMin, pass: finite(realtime[tag]) && realtime[tag] >= bars.realtimeMin },
    droppedFrames: { value: dropped[tag] ?? null, bar: bars.droppedFrameFractionMax, pass: finite(dropped[tag]) && dropped[tag] <= bars.droppedFrameFractionMax },
    evaluationShortfall: { value: shortfallByClient[tag], bar: bars.evaluationShortfallMax, pass: finite(shortfallByClient[tag]) && shortfallByClient[tag] <= bars.evaluationShortfallMax },
  }]));
  const cpu = cpuSummary({ ...recompute, cpuSamples: recompute.cpuSamples ?? figures.cpuSamples,
    cpuSampleFile: recompute.cpuSampleFile ?? figures.cpuSampleFile });
  const common = {
    viewers: tags,
    bars: { realtimeMin: bars.realtimeMin, droppedFrameFractionMax: bars.droppedFrameFractionMax, evaluationShortfallMax: bars.evaluationShortfallMax, steadyUtilisationMax: utilisationBar },
    utilisation: { value: utilisation ?? null, bar: utilisationBar, pass: finite(utilisation) && utilisation <= utilisationBar },
    byClient: barsByClient,
    evaluationShortfallByClient: shortfallByClient,
    peerSourcesByClient: figures.peerSourcesByClient
      ?? Object.fromEntries(tags.map((tag) => [tag, sourceBytes(recompute, tag)])),
    cpu,
    refusals,
  };
  if (currentRefusals.length) {
    return {
      ...common,
      attempt: 'refused',
      availability: refusedAttempts.length >= 2 ? 'unavailable' : null,
      reason: refusedAttempts.length >= 2 ? 'instrument' : 'refused',
      refusalAttempts: refusedAttempts.length,
    };
  }
  const resourceClients = tags.filter((tag) => barsByClient[tag].droppedFrames.pass === false
    || barsByClient[tag].evaluationShortfall.pass === false);
  const realtimeClients = tags.filter((tag) => barsByClient[tag].realtime.pass === false);
  if (tags.every((tag) => barsByClient[tag].realtime.pass && barsByClient[tag].droppedFrames.pass
    && barsByClient[tag].evaluationShortfall.pass)) {
    return { ...common, attempt: 'accepted', availability: 'available', reason: null };
  }
  if (finite(utilisation) && utilisation > utilisationBar) {
    return { ...common, attempt: 'accepted', availability: 'unavailable', reason: 'link', resourceClients, realtimeClients };
  }
  if (resourceClients.length) {
    return { ...common, attempt: 'accepted', availability: 'unavailable', reason: 'resource', resourceClients, realtimeClients };
  }
  return { ...common, attempt: 'accepted', availability: 'unavailable', reason: 'cause-not-established', resourceClients, realtimeClients };
}
