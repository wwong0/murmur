import { median, percentile } from '../../public/lib/frame-drift.mjs';
import { capUsed } from './cap-used.mjs';
import { paceBoundFraction } from './pace-bound.mjs';
import { figuresForWindows, linkUtilisation } from './qa-recompute.mjs';
import { presentedFrameRealtimeFactorByClient, trapFigures } from './trap-figures.mjs';
import { pairwiseDrift } from './pairwise-drift.mjs';
import { driftContext } from './drift-context.mjs';
import { computeSpanCourse } from './span-course.mjs';
import { evidenceRefusals, recordingTailMs as evidenceRecordingTailMs } from '../harness/control-evidence.mjs';
import { bracketHalfWidths, coverageGap, heldAheadAt, pollGaps } from './poll-coverage.mjs';
import { mediaTimeRatio } from './edge-figures.mjs';
import { edgeReading } from './edge-reading.mjs';
import { landingReading, waitParts } from './landing.mjs';

const finite = (value) => Number.isFinite(value);
const ordered = (values) => values.filter(finite).sort((a, b) => a - b);

function capacityRate(readings) {
  const value = readings?.rate?.got ?? readings?.rateBitsPerSecond ?? readings?.rate;
  return finite(value) && value > 0 ? value : null;
}

export function estimateFigure({ hostPace, hostPaceFinal, capacityBeforeReadings, window, wallOffsetMs } = {}) {
  const pace = hostPaceFinal ?? hostPace ?? {};
  const estimate = pace.estimate ?? {};
  const bytesPerSecond = finite(estimate.bytesPerSecond) ? estimate.bytesPerSecond : null;
  const rateBitsPerSecond = capacityRate(capacityBeforeReadings);
  const ratio = finite(bytesPerSecond) && finite(rateBitsPerSecond)
    ? bytesPerSecond * 8 / rateBitsPerSecond : null;
  const intervals = hostPace?.intervals ?? [];
  const paceBound = finite(wallOffsetMs) && window && intervals.length
    ? paceBoundFraction({ intervals, window, wallOffsetMs }) : null;
  return {
    bytesPerSecond,
    intervalsBehind: finite(estimate.intervalsBehind) ? estimate.intervalsBehind : null,
    linkBoundTotal: finite(estimate.linkBoundTotal) ? estimate.linkBoundTotal : null,
    rateBitsPerSecond,
    ratio,
    paceBytesPerSecond: finite(pace.paceBytesPerSecond) ? pace.paceBytesPerSecond : null,
    fraction: pace.fraction ?? null,
    paceBoundFraction: paceBound,
  };
}

function pollShared(poll) {
  return poll?.sharedMs ?? null;
}

export function timebaseJoin(hostPoll = []) {
  const usable = (Array.isArray(hostPoll) ? hostPoll : []).filter((poll) =>
    finite(poll?.sharedMs) && finite(poll?.harnessBeforeMs) && finite(poll?.harnessAfterMs));
  if (!usable.length) return null;
  if (usable.length < 2) throw new Error('timebase join requires at least two host polls');
  const offsets = usable.map((poll) => poll.sharedMs - (poll.harnessBeforeMs + poll.harnessAfterMs) / 2);
  const wallOffsets = usable.filter((poll) => finite(poll.pageWallMs))
    .map((poll) => poll.pageWallMs - (poll.harnessBeforeMs + poll.harnessAfterMs) / 2);
  const offsetMs = median(ordered(offsets));
  const wallOffsetMs = wallOffsets.length ? median(ordered(wallOffsets)) : null;
  const medianIndex = Math.floor((usable.length - 1) / 2);
  const medianPoll = usable.slice().sort((a, b) => offsets[usable.indexOf(a)] - offsets[usable.indexOf(b)])[medianIndex];
  const bracketHalfWidth = Math.max(...usable.map((poll) => (poll.harnessAfterMs - poll.harnessBeforeMs) / 2));
  const clockHalfWidth = Number(medianPoll?.clock?.halfWidthMs);
  if (!finite(bracketHalfWidth) || bracketHalfWidth < 0 || !finite(clockHalfWidth) || clockHalfWidth < 0) {
    throw new Error('timebase join clock half-width is unavailable');
  }
  const brackets = bracketHalfWidths(usable);
  return {
    offsetMs,
    wallOffsetMs,
    halfWidthMs: bracketHalfWidth + clockHalfWidth,
    bracketHalfWidthMedianMs: brackets.medianMs,
    bracketHalfWidthMaxMs: brackets.maxMs,
    sampleCount: usable.length,
    harness: (sharedMs) => sharedMs - offsetMs,
  };
}

function joinEntries(joins, tag) {
  const entry = joins?.[tag];
  return Array.isArray(entry) ? entry : (Array.isArray(entry?.joined) ? entry.joined : []);
}

function identityOf(state) {
  return state && typeof state.lineage === 'string' && Number.isInteger(state.version)
    ? { lineage: state.lineage, version: state.version } : null;
}

function resumedState(hostPoll, identity) {
  if (!identity) return null;
  return hostPoll.find((poll) => poll.state?.lineage === identity.lineage
    && Number.isInteger(poll.state?.version) && poll.state.version > identity.version) ?? null;
}

function holdEntry({ kind, held, transitionSharedMs, hostPoll, resumes, recordingEndShared, trap, reason }) {
  const identity = identityOf(held);
  const resume = (Array.isArray(resumes) ? resumes : []).find((entry) =>
    entry.identity?.lineage === identity?.lineage && entry.identity?.version === identity?.version);
  const resumed = resumedState(hostPoll, identity);
  const resumedAtSharedMs = resumed?.state?.atSharedMs;
  const heldAtSharedMs = held?.atSharedMs;
  const lengthEnd = finite(resumedAtSharedMs) ? resumedAtSharedMs : recordingEndShared;
  return {
    kind,
    identity,
    held: held ?? null,
    transitionSharedMs,
    transitionAtSharedMs: transitionSharedMs,
    resume: resume ?? null,
    cause: resume?.cause ?? null,
    issuedAtSharedMs: resume?.issuedAtSharedMs ?? null,
    holdMs: resume?.holdMs ?? null,
    viewers: resume?.viewers ?? {},
    resumed: Boolean(resumed),
    resumedAtSharedMs: finite(resumedAtSharedMs) ? resumedAtSharedMs : null,
    waitMs: finite(resumedAtSharedMs) && finite(transitionSharedMs)
      ? resumedAtSharedMs - transitionSharedMs : null,
    lengthMs: finite(lengthEnd) && finite(heldAtSharedMs) ? lengthEnd - heldAtSharedMs : null,
    trap,
    ...(reason ? { reason } : {}),
  };
}

function startTransition(joins, declaredViewers) {
  const details = {};
  let transition = null;
  let reason = null;
  for (const tag of declaredViewers) {
    const entries = joinEntries(joins, tag).filter((entry) => finite(entry?.recvSharedMs));
    details[tag] = entries;
    if (!entries.length) reason = reason ?? 'start-join-missing';
    else transition = Math.max(transition ?? -Infinity, entries[0].recvSharedMs);
  }
  return { transition, details, reason };
}

export function holds({ hostPoll = [], resumes = [], joins = {}, declaredViewers = [], seek = null,
  recordingEndShared, input = {}, window } = {}) {
  const first = hostPoll.find((poll) => poll?.state)?.state;
  if (!first) throw new Error('host poll has no playback state');
  const start = startTransition(joins, declaredViewers);
  const startResume = resumedState(hostPoll, identityOf(first));
  const startResumeAt = startResume?.state?.atSharedMs;
  const priorJoinCount = Object.values(start.details).some((entries) => entries
    .filter((entry) => !finite(startResumeAt) || entry.recvSharedMs <= startResumeAt).length > 1)
    ? 'start-roster-churn' : null;
  const early = finite(startResume?.state?.atSharedMs) && finite(start.transition)
    && startResume.state.atSharedMs < start.transition ? 'resumed-before-roster-complete' : null;
  const startTrap = seek ? trapFigures(input, window) : null;
  const entries = [holdEntry({ kind: 'start', held: first, transitionSharedMs: start.transition,
    hostPoll, resumes, recordingEndShared, trap: startTrap,
    reason: start.reason ?? priorJoinCount ?? early })];
  if (seek) {
    const held = seek.host;
    const seekReason = held?.held === true ? null : 'seek-hold-unobserved';
    entries.push(holdEntry({ kind: 'seek', held, transitionSharedMs: held?.atSharedMs ?? null,
      hostPoll, resumes, recordingEndShared, trap: startTrap, reason: seekReason }));
  }
  const known = new Set(entries.map((entry) => {
    const identity = entry.identity;
    return identity ? `${identity.lineage}:${identity.version}` : null;
  }).filter(Boolean));
  for (const poll of hostPoll) {
    const held = poll?.state;
    if (held?.held !== true) continue;
    const identity = identityOf(held);
    const key = identity ? `${identity.lineage}:${identity.version}` : null;
    if (key && known.has(key)) continue;
    if (key) known.add(key);
    entries.push(holdEntry({ kind: 'additional', held, transitionSharedMs: null,
      hostPoll, resumes, recordingEndShared, trap: null }));
  }
  return { entries, start: entries[0], seek: entries[1] ?? null,
    reasons: entries.filter((entry) => entry.reason).map((entry) => entry.reason) };
}

export function widenedBars(bars, spanMs, edgeSegments, segmentSeconds) {
  if (!finite(segmentSeconds) || segmentSeconds <= 0) throw new Error('segment-seconds-unavailable');
  const edge = 2 * edgeSegments * segmentSeconds * 1000 / spanMs;
  // An undeclared bar is no value, as steadyState reads it: never a widened NaN.
  const widen = (bar, by) => (finite(bar) ? bar + by : null);
  return {
    downloadRatioMin: widen(bars?.steadyDownloadRatioMin, -edge),
    downloadRatioMax: widen(bars?.steadyDownloadRatioMax, edge),
    utilisationMax: bars?.steadyUtilisationMax ?? null,
    realtimeMin: bars?.steadyRealtimeMin ?? null,
    paceBoundMax: bars?.steadyPaceBoundMax ?? null,
    // Present only where declared: a registered span's published bars keep their shape.
    ...(finite(bars?.steadyCapUsedMax) ? { capUsedMax: bars.steadyCapUsedMax } : {}),
  };
}

function leg(value, bar, pass = finite(value) && finite(bar) && value <= bar) {
  return { value: finite(value) ? value : null, bar: finite(bar) ? bar : null, pass };
}

function linkFigure(samples, window, capacityBitsPerSecond) {
  const entries = (samples ?? []).filter((sample) => finite(sample?.atMs ?? sample?.at)
    && finite(sample?.txBytes ?? sample?.tx_bytes))
    .map((sample) => ({ ...sample, atMs: sample.atMs ?? sample.at, txBytes: sample.txBytes ?? sample.tx_bytes }))
    .filter((sample) => sample.atMs >= window.startMs && sample.atMs <= window.endMs);
  const value = linkUtilisation(samples, [window], capacityBitsPerSecond);
  if (!entries.length) return { uplinkUtilisationMean: value };
  const backlog = entries.map((sample) => sample.qdisc?.backlogBytes ?? sample.backlogBytes ?? sample.qdiscBacklogBytes);
  const finiteBacklog = backlog.filter(finite);
  if (!finiteBacklog.length || !finite(capacityBitsPerSecond) || capacityBitsPerSecond <= 0) {
    return { uplinkUtilisationMean: value };
  }
  const delays = finiteBacklog.map((bytes) => bytes * 8 / capacityBitsPerSecond * 1000);
  return {
    uplinkUtilisationMean: value,
    qdiscBacklogNonzeroFraction: finiteBacklog.filter((bytes) => bytes > 0).length / finiteBacklog.length,
    standingQueueDelayMsP50NearestRank: percentile([...delays].sort((a, b) => a - b), 0.5),
    standingQueueDelayMsP99: percentile([...delays].sort((a, b) => a - b), 0.99),
  };
}

function spanLegs({ input, window, tags, bars, edgeSegments, segmentSeconds, hostPace, wallOffsetMs }) {
  const windows = Object.fromEntries(tags.map((tag) => [tag, window]));
  let figures = {};
  try { figures = figuresForWindows(input, windows, true); } catch {}
  const ratio = Object.fromEntries(tags.map((tag) => [tag, figures.downloadRatioByClient?.[tag] ?? null]));
  const realtime = presentedFrameRealtimeFactorByClient(input, window);
  const widened = widenedBars(bars, window.endMs - window.startMs, edgeSegments, segmentSeconds);
  const ratioPass = finite(widened.downloadRatioMin) && finite(widened.downloadRatioMax)
    && tags.every((tag) => finite(ratio[tag]) && ratio[tag] >= widened.downloadRatioMin && ratio[tag] <= widened.downloadRatioMax);
  const realtimePass = finite(widened.realtimeMin)
    && tags.every((tag) => finite(realtime[tag]) && realtime[tag] >= widened.realtimeMin);
  const utilisationValue = linkFigure(input.linkSamples, window, input.capacityBitsPerSecond).uplinkUtilisationMean;
  const utilisation = leg(utilisationValue, widened.utilisationMax);
  // The cap leg is in force only where declared (design.md D2); otherwise the
  // pace-bound leg is exactly the registered one, so 8b2's figures recompute.
  const capDeclared = finite(widened.capUsedMax);
  if (capDeclared && finite(widened.paceBoundMax)) throw new Error('steady-pace-bars-conflict');
  const paced = finite(input.headroom?.fraction);
  if (capDeclared && paced && !finite(wallOffsetMs)) {
    throw new Error('steady-state cap-used wall offset is unavailable');
  }
  const cap = paced && finite(wallOffsetMs) && (capDeclared || hostPace?.intervals)
    ? capUsedFigure({ ...input, hostPace }, window, wallOffsetMs) : null;
  const pace = finite(wallOffsetMs) && hostPace?.intervals
    ? paceBoundFraction({ intervals: hostPace.intervals, window, wallOffsetMs }) : null;
  const paceLeg = capDeclared || !pace ? null : { ...pace, bar: widened.paceBoundMax,
    pass: pace.value !== null && finite(widened.paceBoundMax) && pace.value <= widened.paceBoundMax };
  const capLeg = capDeclared && paced ? { ...cap, bar: widened.capUsedMax,
    pass: finite(cap.value) && cap.value <= widened.capUsedMax } : null;
  const legs = {
    utilisation,
    downloadRatio: { byClient: ratio, bars: { min: widened.downloadRatioMin, max: widened.downloadRatioMax }, pass: ratioPass },
    realtime: { byClient: realtime, bar: widened.realtimeMin, pass: realtimePass },
    ...(capLeg ? { capUsed: capLeg } : {}),
    ...(paceLeg ? { paceBound: paceLeg } : {}),
  };
  // Both values are published outside `legs`: every entry of `legs` without
  // `pass: true` is counted as failed by the readers.
  const paceSummary = paced && cap && pace ? {
    tested: capDeclared ? 'capUsed' : finite(widened.paceBoundMax) ? 'paceBound' : null,
    capUsed: { value: cap.value, handedBytes: cap.handedBytes, allowedBytes: cap.allowedBytes, reason: cap.reason },
    paceBound: { value: pace.value, pacedMs: pace.pacedMs, reason: pace.reason },
  } : null;
  // The host's polls are tested only where the condition declares it, so a run
  // registered before 9b recomputes as it read.
  const edgeDeclared = edgeReading(input.condition?.reading);
  const hostGap = edgeDeclared && coverageGap(input.hostPoll, window) > 1_000;
  const incomplete = hostGap || tags.some((tag) => coverageGap(input.viewerPolls?.[tag], window) > 1_000)
    || Boolean((capDeclared ? capLeg : pace)?.reason);
  const pass = !incomplete && Object.values(legs).every((entry) => entry.pass === true);
  // Published beside the legs and never counted with them (9b design.md D7).
  const beside = edgeDeclared ? { downloadRatioMediaTime: { byClient: mediaTimeRatio(figures, tags, segmentSeconds) },
    heldAheadMsByClient: heldAheadAt(input.viewerPolls, tags, window.endMs) } : {};
  return { window, bars: widened, legs, ...beside, ...(paceSummary ? { pace: paceSummary } : {}), incomplete, pass,
    failedLegs: Object.entries(legs).filter(([, entry]) => entry.pass !== true).map(([name]) => name) };
}

function capUsedFigure(input, window, wallOffsetMs) {
  return capUsed({ intervals: input.hostPace?.intervals ?? [], window, wallOffsetMs,
    fraction: input.headroom.fraction, finalEstimateBytesPerSecond: input.hostPaceFinal?.estimate?.bytesPerSecond });
}

export function recoverySpans({ input = {}, transition, spanMs = 60_000, recordingEnd, bars = input.condition?.bars,
  edgeSegments = 1, segmentSeconds = input.segmentSeconds, viewerPolls = input.viewerPolls,
  hostPace = input.hostPace, wallOffsetMs = input.wallOffsetMs, capacityBitsPerSecond = input.capacityBitsPerSecond } = {}) {
  if (!finite(segmentSeconds) || segmentSeconds <= 0) throw new Error('segment-seconds-unavailable');
  if (!finite(transition) || !finite(recordingEnd) || !(spanMs > 0)) return { spans: [], trailingMs: 0 };
  const tags = input.declaredClientTags ?? Object.keys(input.clients ?? {});
  const spans = [];
  for (let startMs = transition; startMs + spanMs <= recordingEnd; startMs += spanMs) {
    const window = { startMs, endMs: startMs + spanMs };
    spans.push(spanLegs({ input: { ...input, viewerPolls, capacityBitsPerSecond }, window, tags, bars,
      edgeSegments, segmentSeconds, hostPace, wallOffsetMs }));
  }
  return { spans, trailingMs: Math.max(0, recordingEnd - transition - spans.length * spanMs) };
}

export function recoveryTime(spans = [], spanMs = 60_000) {
  if (!Array.isArray(spans) || !spans.length) return { unestablished: true, recovered: null, recoveryMs: null };
  const passed = (span) => span?.pass === true || (span?.pass === undefined
    && span?.incomplete !== true && Object.values(span?.legs ?? {}).every((legValue) => legValue.pass === true));
  const last = spans.at(-1);
  if (last.incomplete === true) return { unestablished: true, recovered: null, recoveryMs: null };
  if (!passed(last)) return { unestablished: false, recovered: false, recoveryMs: null };
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    if (spans[index].incomplete === true) return { unestablished: false, recovered: true, recoveryMs: null, recoveryAtMostMs: (index + 1) * spanMs };
    if (!passed(spans[index])) return { unestablished: false, recovered: true, recoveryMs: (index + 1) * spanMs };
  }
  return { unestablished: false, recovered: true, recoveryMs: 0 };
}

function sweepSpan(input, window, resumedAtSharedMs) {
  const tags = input.declaredClientTags ?? Object.keys(input.clients ?? {});
  const offsetMs = finite(input.timebase?.offsetMs) ? input.timebase.offsetMs : 0;
  const sharedWindow = { startMs: window.startMs + offsetMs, endMs: window.endMs + offsetMs };
  const context = driftContext({ clients: input.clients, tags, window: sharedWindow,
    manifest: input.manifest, clockJoin: input.clockJoin });
  const halfWidths = {};
  const allPolls = { host: input.hostPoll ?? [], ...(input.viewerPolls ?? {}) };
  for (const [tag, polls] of Object.entries(allPolls)) {
    const inSpan = (polls ?? []).filter((poll) => {
      const at = poll.harnessAfterMs ?? poll.harnessBeforeMs ?? poll.atMs;
      return finite(at) && at >= window.startMs && at <= window.endMs;
    });
    const values = inSpan.map((poll) => poll.clock?.halfWidthMs).filter(finite);
    halfWidths[tag] = values.length ? { median: median(ordered(values)), max: Math.max(...values) } : null;
  }
  const drift = sharedWindow.startMs >= resumedAtSharedMs
    ? pairwiseDrift({ clients: input.clients, tags, window: sharedWindow, frameRate: input.content?.frameRate,
      presentIntervalMsByClient: context.presentIntervalMsByClient }) : null;
  const wallOffsetMs = input.timebase?.wallOffsetMs;
  const paceBound = finite(wallOffsetMs) && input.hostPace?.intervals
    ? paceBoundFraction({ intervals: input.hostPace.intervals, window, wallOffsetMs }) : null;
  const capUsed = finite(input.headroom?.fraction) && finite(wallOffsetMs) && Array.isArray(input.hostPace?.intervals)
    ? capUsedFigure(input, window, wallOffsetMs) : null;
  return { window, ...linkFigure(input.linkSamples, window, input.capacityBitsPerSecond), paceBound, capUsed,
    drift, clockHalfWidthMsByClient: halfWidths, displayCadence: context.presentIntervalMsByClient ?? {} };
}

export function sweepFigures({ input, spans = [], resumedAtSharedMs = -Infinity } = {}) {
  return spans.map((span) => sweepSpan(input, span.window ?? span, resumedAtSharedMs));
}

// Each hold's spans run from its transition (spec item 11), in harness time;
// a start's stop at the seek, which is the next disturbance.
export function holdRecoveries({ input = {}, join, holds: held, recordingEndHarnessMs } = {}) {
  const spanMs = input.condition?.reading?.spanMs ?? 60_000;
  const harnessOf = (sharedMs) => (finite(sharedMs) ? join.harness(sharedMs) : null);
  const seekTransition = input.seek ? harnessOf(held.seek?.transitionSharedMs) : null;
  const recoveryFrom = (transition, recordingEnd) => {
    if (!finite(transition) || !finite(recordingEnd)) return null;
    const result = recoverySpans({ input: { ...input, timebase: join }, transition, recordingEnd, spanMs,
      edgeSegments: input.condition?.reading?.spanEdgeSegments ?? 1, bars: input.condition?.bars,
      viewerPolls: input.viewerPolls, hostPace: input.hostPace, wallOffsetMs: join.wallOffsetMs });
    return { ...result, result: recoveryTime(result.spans, spanMs) };
  };
  // A capacity schedule's drop is a disturbance as the seek is: spans stop at it.
  const dropAt = input.capacitySchedule?.drop?.appliedAtMs;
  const beforeDrop = (transition) => (finite(dropAt) && finite(transition) && dropAt > transition ? dropAt : recordingEndHarnessMs);
  return {
    start: recoveryFrom(harnessOf(held.start?.transitionSharedMs), seekTransition ?? beforeDrop(harnessOf(held.start?.transitionSharedMs))),
    seek: recoveryFrom(seekTransition, beforeDrop(seekTransition)),
  };
}

export function computeControlFigures(input = {}, { manifest = input.manifest } = {}) {
  if (input.condition && !input.condition.peerExchange) return null;
  if (!Array.isArray(input.hostPoll) || input.hostPoll.length === 0) return null;
  const join = input.timebase ?? timebaseJoin(input.hostPoll);
  if (!join) throw new Error('timebase join is unavailable');
  const recordingEndHarnessMs = input.hostPoll.at(-1)?.harnessAfterMs ?? null;
  const recordingEndShared = finite(recordingEndHarnessMs) && join ? recordingEndHarnessMs + join.offsetMs : null;
  const declaredViewers = input.declaredClientTags ?? Object.keys(input.clients ?? {});
  const holdInput = { ...input, manifest };
  const holdResult = holds({ hostPoll: input.hostPoll, resumes: input.resumes?.records ?? input.resumes ?? [],
    joins: input.clockJoin, declaredViewers, seek: input.seek, recordingEndShared, input: holdInput, window: input.window });
  const waitPartResult = waitParts({ holds: holdResult, viewerPolls: input.viewerPolls, declaredViewers, timebase: join });
  const estimate = estimateFigure({ hostPace: input.hostPace, hostPaceFinal: input.hostPaceFinal,
    capacityBeforeReadings: input.capacityBeforeReadings, window: input.window, wallOffsetMs: join?.wallOffsetMs });
  const seekHold = holdResult.seek;
  const recovery = holdRecoveries({ input, join, holds: holdResult, recordingEndHarnessMs });
  const spans = recovery.seek?.spans ?? [];
  return {
    estimate,
    timebase: { offsetMs: join.offsetMs, wallOffsetMs: join.wallOffsetMs, halfWidthMs: join.halfWidthMs, sampleCount: join.sampleCount,
      bracketHalfWidthMedianMs: join.bracketHalfWidthMedianMs ?? null, bracketHalfWidthMaxMs: join.bracketHalfWidthMaxMs ?? null },
    pollGaps: pollGaps({ hostPoll: input.hostPoll, viewerPolls: input.viewerPolls }),
    holds: holdResult,
    waitParts: waitPartResult,
    landing: landingReading({ holds: holdResult, seek: input.seek, content: input.contentManifest ?? input.content,
      hostResponses: input.originEnd?.responseRecords ?? [], clients: input.clients, asks: input.asks,
      timebase: join, segmentSizes: input.contentManifest?.segmentSizes ?? input.content?.segmentSizes }),
    recordingEndHarnessMs,
    recordingEndSharedMs: recordingEndShared,
    recordingTailMs: input.seek ? evidenceRecordingTailMs({ join, seek: input.seek, windowEndMs: input.window?.endMs }) : 0,
    recovery,
    sweep: input.seek ? sweepFigures({ input: { ...input, manifest, timebase: join }, spans, resumedAtSharedMs: seekHold?.resumedAtSharedMs ?? Infinity }) : null,
    spanCourse: input.seek ? computeSpanCourse(input) : null,
    refusals: evidenceRefusals({ hostPace: input.hostPace, resumes: input.resumes, hostPoll: input.hostPoll, seek: input.seek }),
  };
}

export { startTransition };
