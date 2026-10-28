import { missingFields } from '../figures/publication.mjs';
import { CDP_QUALIFICATION_REASON } from './qualification.mjs';
import { evaluateByteControl } from './byte-control.mjs';
import { armFor, REFUSAL_SCOPE } from './arms.mjs';
import { appliedSeekEvidence, appliedWithoutRestart } from '../figures/seek-evidence.mjs';
import { scheduleRefusals } from './capacity-schedule.mjs';
import { removesMember } from './roster-kinds.mjs';
import { countedRealtimeFactor, notPresenting, STALL_COUNTED_CONTEXT_FIELDS, STALL_COUNTED_REASONS } from './not-presenting.mjs';

export const REFUSAL_REASONS = Object.freeze([
  'client-never-began-playback',
  'client-holds-no-drift-records',
  'record-coverage-below-declared-fraction',
  'record-coverage-unavailable',
  'drift-log-discarded-records',
  'drift-log-missed-unavailable',
  'drift-page-reset',
  'drift-drain-gap-unavailable',
  'drift-drain-gap-over-60s',
  'dropped-frame-evidence-unavailable',
  'dropped-frames-above-declared-bar',
  'origin-unattributed-bytes-nonzero',
  'server-refused-tab-id',
  'run-directory-exists',
  'client-cadence-unavailable',
  'client-did-not-start',
  CDP_QUALIFICATION_REASON,
  'viewer-media-over-http',
  'host-uplink-below-delivered',
  'host-uplink-evidence-unavailable',
  'receipt-log-discarded-records',
  'receipt-log-reset',
  'peer-byte-control-unavailable',
  'peer-byte-control-above-declared-bar',
  'origin-client-agreement-unavailable',
  'origin-client-agreement-above-declared-bar',
  'peer-exchange-inactive',
  'peer-attribution-unavailable',
  'peer-log-discarded-records',
  'peer-log-reset',
  'peer-anomaly-records',
  'peer-cohort-empty',
  'peer-conservation-tolerance-unbounded',
  'peer-check-failed:response-agreement',
  'peer-check-failed:segment-sum',
  'peer-check-failed:peer-id-membership',
  'peer-check-failed:conservation',
  'peer-check-not-exercised:response-agreement',
  'peer-check-not-exercised:segment-sum',
  'peer-check-not-exercised:peer-id-membership',
  'peer-check-not-exercised:conservation',
  'position-offset-mismatch',
  'build-mismatch',
  'capacity-step-not-in-force',
  'capacity-schedule-not-in-force',
  'seek-not-applied',
  'seek-target-missed',
  'seek-landed-on-held-media',
  'roster-event-not-issued',
  'roster-event-not-observed',
]);

const PUBLICATION_ONLY_REASONS = new Set([CDP_QUALIFICATION_REASON]);

const finite = (value) => Number.isFinite(value);
const present = (value) => value !== undefined && value !== null;
const eventTime = (record) => record?.displaySharedMs ?? record?.atMs ?? record?.endMs;

function inWindow(records, window) {
  if (!Array.isArray(records)) return [];
  if (!finite(window?.startMs) || !finite(window?.endMs)) return records;
  return records.filter((record) => {
    const at = eventTime(record);
    return finite(at) && at >= window.startMs && at <= window.endMs;
  });
}

function addReason(reasons, reason, scope, detail = {}) {
  reasons.push({ reason, scope: [...scope], ...detail });
}

function countedReasonNamesTag(entry, tag) {
  return entry.tag === tag || (typeof entry.field === 'string' && entry.field.endsWith(`[${tag}]`));
}

function moveCountedReasons(reasons, tag) {
  const moved = [];
  const kept = [];
  for (const entry of reasons) {
    const stallReason = STALL_COUNTED_REASONS.includes(entry.reason) && countedReasonNamesTag(entry, tag);
    const contextReason = STALL_COUNTED_CONTEXT_FIELDS.some((field) =>
      entry.reason === `required-context-absent:${field}[${tag}]`);
    if (stallReason || contextReason) moved.push(entry);
    else kept.push(entry);
  }
  reasons.splice(0, reasons.length, ...kept);
  return moved;
}

export function summarizeRefusalReasons(reasons = []) {
  const entries = Array.isArray(reasons) ? reasons : [];
  const uniqueReasonSet = [...new Set(entries.map((entry) => entry.reason))];
  const duplicateReasons = entries.map((entry) => entry.reason)
    .filter((reason, index, all) => all.indexOf(reason) !== index);
  const suppressed = { byte: false, drift: false };
  for (const entry of entries) for (const figure of entry.scope ?? []) suppressed[figure] = true;
  return {
    refused: entries.length > 0,
    runRefused: entries.some((entry) => !entry.reason.startsWith('required-context-absent:')
      && !PUBLICATION_ONLY_REASONS.has(entry.reason)
      && ((entry.scope ?? []).includes('byte') || (entry.scope ?? []).includes('drift')
        || entry.reason === 'run-directory-exists')),
    publicationRefused: entries.some((entry) => entry.reason.startsWith('required-context-absent:')
      || PUBLICATION_ONLY_REASONS.has(entry.reason)),
    reasonSet: uniqueReasonSet,
    duplicateReasons: [...new Set(duplicateReasons)],
    figures: { byte: !suppressed.byte, drift: !suppressed.drift },
  };
}

function counterDelta(after, before, field) {
  const right = Number(after?.[field] ?? 0);
  const left = Number(before?.[field] ?? 0);
  return finite(right) && finite(left) ? right - left : undefined;
}

function clientRecords(client) {
  return client?.records ?? [];
}

function clientPolls(client) {
  return client?.polls ?? [];
}

function rosterEventRefusal(input, addReason) {
  const condition = input.condition ?? {};
  if (!(condition.figureKinds ?? []).includes('roster-event')) return;
  const event = input.rosterEvent;
  if (!event || typeof event !== 'object') {
    addReason('roster-event-not-issued', REFUSAL_SCOPE.churn, { figure: 'roster-event' });
    return;
  }
  const tags = input.declaredClientTags ?? Object.keys(input.presence ?? {});
  const others = tags.filter((tag) => tag !== event.client);
  const presence = input.presence ?? {};
  const expected = event.kind === 'join' ? 'join' : 'leave';
  const seq = event.presence?.seq;
  const missingTags = others.filter((tag) => !(presence[tag] ?? []).some((record) =>
    record?.seq === seq && record?.event === expected && record?.tabId === event.tabId));
  if (!Number.isSafeInteger(seq) || missingTags.length) {
    addReason('roster-event-not-observed', REFUSAL_SCOPE.churn, { figure: 'roster-event', missingTags });
  }
}

// 10b design.md D7: the member a leave removed ends its streams at the event by design,
// and a joiner was not in the room when the cadence was established. Their reasons are
// kept, named, beside the ones the run is judged on.
const ROSTER_EVENT_EXCUSABLE_REASONS = new Set([
  'client-never-began-playback',
  'record-coverage-unavailable',
  'dropped-frame-evidence-unavailable',
  'viewer-interface-evidence-unavailable',
  'engine-windows-unavailable',
]);

function rosterExcusableReason(reason, tag) {
  return ROSTER_EVENT_EXCUSABLE_REASONS.has(reason)
    || reason === `required-context-absent:stallCountByClient[${tag}]`
    || reason === `required-context-absent:keptHostBytesByClient[${tag}]`;
}

export function excusedByRosterEvent(condition, event, reasons, clients) {
  const kind = condition.rosterEvent?.kind;
  const tag = event?.client;
  if (typeof tag !== 'string') return [];
  if (kind === 'join') {
    const excused = [];
    for (let index = reasons.length - 1; index >= 0; index -= 1) {
      const entry = reasons[index];
      const named = entry.tag === tag || (typeof entry.field === 'string' && entry.field.endsWith(`[${tag}]`));
      if (named && entry.reason === 'client-cadence-unavailable') excused.unshift(...reasons.splice(index, 1));
    }
    return excused;
  }
  if (!removesMember(kind)) return [];
  // Shared clock only: the drift records are shared, the issue instant is the harness's.
  const issueMs = event?.presence?.recvSharedMs;
  const hasPresentedBeforeIssue = (clients?.[tag]?.records ?? []).some((record) =>
    finite(record?.displaySharedMs) && finite(issueMs) && record.displaySharedMs <= issueMs
      && finite(record.presentedFrames) && record.presentedFrames > 0);
  if (!hasPresentedBeforeIssue) return [];
  const excused = [];
  for (let index = reasons.length - 1; index >= 0; index -= 1) {
    const entry = reasons[index];
    const named = entry.tag === tag || (typeof entry.field === 'string' && entry.field.endsWith(`[${tag}]`));
    if (named && rosterExcusableReason(entry.reason, tag)) {
      excused.unshift(...reasons.splice(index, 1));
    }
  }
  return excused;
}

function coverageFor(tag, client, window, minimum) {
  const records = inWindow(clientRecords(client), window);
  const bad = { tag, records: records.length };
  if (records.length === 0) return { available: false, detail: { ...bad, reason: 'empty-window' } };
  let previousSeq;
  let previousPresented;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!finite(record?.seq) || (previousSeq !== undefined && record.seq <= previousSeq)) {
      return { available: false, detail: { ...bad, index, field: 'seq', record } };
    }
    if (!finite(record?.presentedFrames)) {
      return { available: false, detail: { ...bad, index, field: 'presentedFrames', record } };
    }
    if (previousPresented !== undefined && record.presentedFrames <= previousPresented) {
      return { available: false, detail: { ...bad, index, field: 'presentedFrames', record } };
    }
    previousSeq = record.seq;
    previousPresented = record.presentedFrames;
  }
  const span = records.at(-1).presentedFrames - records[0].presentedFrames + 1;
  if (!(span > 0)) return { available: false, detail: { ...bad, field: 'presentedFramesSpan', span } };
  const coverage = records.length / span;
  const passes = records.length + 0.5 >= minimum * span;
  return { available: true, records: records.length, span, coverage, passes, detail: bad };
}

function droppedFraction(client, window) {
  const polls = inWindow(clientPolls(client), window);
  if (polls.length < 2) return { available: false, detail: { field: 'quality' } };
  let previous;
  for (const poll of polls) {
    const quality = poll?.quality;
    const dropped = Number(quality?.droppedVideoFrames);
    const total = Number(quality?.totalVideoFrames);
    if (!finite(dropped) || !finite(total)
      || (previous && (dropped < previous.dropped || total < previous.total))) {
      return { available: false, detail: { dropped, total, field: 'quality' } };
    }
    previous = { dropped, total };
  }
  const first = polls[0]?.quality;
  const last = polls.at(-1)?.quality;
  const dropped = Number(last.droppedVideoFrames) - Number(first.droppedVideoFrames);
  const total = Number(last.totalVideoFrames) - Number(first.totalVideoFrames);
  if (!finite(dropped) || !finite(total) || total <= 0 || dropped < 0) {
    return { available: false, detail: { dropped, total, field: 'quality' } };
  }
  return { available: true, dropped, total, fraction: dropped / total };
}

export function evaluateRefusals(input = {}) {
  const condition = input.condition ?? {};
  const bars = condition.bars ?? {};
  const window = input.window ?? condition.window;
  const clients = input.clients ?? {};
  const tags = input.declaredClientTags ?? Object.keys(clients);
  const reasons = [];
  const coverage = {};
  const dropped = {};
  const realtimeFactorByClient = {};
  const noFrameMsByClient = {};

  rosterEventRefusal(input, (reason, scope, detail) => addReason(reasons, reason, scope, detail));

  if (input.capacityStep && input.seek
    && Number.isFinite(input.capacityStep.readBackAtMs)
    && Number.isFinite(input.seek.seekIssuedAtMs)
    && input.capacityStep.readBackAtMs > input.seek.seekIssuedAtMs) {
    throw new Error('capacity-step-readback-after-seek');
  }

  for (const tag of tags) {
    const client = clients[tag] ?? {};
    const playback = client.finalPlayback ?? {};
    if (playback.begun === undefined || playback.begun === 0) {
      addReason(reasons, 'client-never-began-playback', REFUSAL_SCOPE.neverPlayed, { tag });
    }
    if (clientRecords(client).length === 0) {
      addReason(reasons, 'client-holds-no-drift-records', REFUSAL_SCOPE.noRecords, { tag });
    }
    const result = coverageFor(tag, client, window, Number(bars.recordCoverageMin));
    coverage[tag] = result;
    const records = inWindow(clientRecords(client), window);
    if (records.length >= 2) {
      const display = records.at(-1).displaySharedMs - records[0].displaySharedMs;
      const media = records.at(-1).mediaMs - records[0].mediaMs;
      if (finite(display) && display > 0 && finite(media)) realtimeFactorByClient[tag] = media / display;
    }
    if (!result.available && !(appliedWithoutRestart(input.seek, tag) && result.detail?.reason === 'empty-window')) {
      addReason(reasons, 'record-coverage-unavailable', REFUSAL_SCOPE.coverage, { tag, detail: result.detail });
    } else if (!result.passes) {
      addReason(reasons, 'record-coverage-below-declared-fraction', REFUSAL_SCOPE.coverage, {
        tag,
        coverage: result.coverage,
        presentedFramesSpan: result.span,
        recordsInWindow: result.records,
      });
    }
    const missed = Number(client.driftLogMissed);
    if (!finite(missed)) {
      addReason(reasons, 'drift-log-missed-unavailable', REFUSAL_SCOPE.driftEvidence, { tag });
    } else if (missed > Number(bars.driftLogMissedMax ?? 0)) {
      addReason(reasons, 'drift-log-discarded-records', REFUSAL_SCOPE.evicted, { tag, missed });
    }
    if (client.pageReset === true) {
      addReason(reasons, 'drift-page-reset', REFUSAL_SCOPE.driftEvidence, { tag });
    }
    const maxGap = Number(client.maxDriftDrainGapMs);
    if (!finite(maxGap)) {
      addReason(reasons, 'drift-drain-gap-unavailable', REFUSAL_SCOPE.driftEvidence, { tag });
    } else if (maxGap > 60_000) {
      addReason(reasons, 'drift-drain-gap-over-60s', REFUSAL_SCOPE.driftEvidence, { tag, maxGapMs: maxGap });
    }
    const quality = droppedFraction(client, window);
    dropped[tag] = quality;
    const zeroDroppedDelta = Number(quality.detail?.total) === 0;
    if (!quality.available && !(appliedWithoutRestart(input.seek, tag) && zeroDroppedDelta)) {
      addReason(reasons, 'dropped-frame-evidence-unavailable', REFUSAL_SCOPE.qualityEvidence, { tag, detail: quality.detail });
    } else if (quality.fraction > Number(bars.droppedFrameFractionMax)) {
      addReason(reasons, 'dropped-frames-above-declared-bar', REFUSAL_SCOPE.droppedFrames, {
        tag,
        fraction: quality.fraction,
        dropped: quality.dropped,
        total: quality.total,
      });
    }
    if (Object.prototype.hasOwnProperty.call(input, 'publicationContext')) {
      const polls = inWindow(clientPolls(client), window);
      const epochs = polls.map((poll) => poll.stalls?.epoch).filter(present);
      if (polls.some((poll) => !present(poll.stalls?.epoch)) || new Set(epochs).size !== 1) {
        addReason(reasons, `required-context-absent:stallCountByClient[${tag}]`, REFUSAL_SCOPE.publication, {
          field: `stallCountByClient[${tag}]`,
          figure: 'byte',
        });
      }
    }
  }

  for (const tag of tags) {
    if (input.startWait?.playingAtMs?.[tag] === null) {
      addReason(reasons, 'client-did-not-start', REFUSAL_SCOPE.startWait, {
        tag, deadlineMs: input.startWait.deadlineMs,
      });
    }
  }

  // The cadence gate is D6's, not D5's. It is evaluated only when the run
  // declares a cadence or publishes a figure, so constructed evidence for the
  // other gates need not carry one.
  if (Object.prototype.hasOwnProperty.call(input, 'cadence') || condition.publishes === true) {
    for (const tag of tags) {
      const record = input.cadence?.[tag];
      if (!record || record.classification === 'none' || !finite(record.presentIntervalMs)) {
        addReason(reasons, 'client-cadence-unavailable', REFUSAL_SCOPE.cadence, {
          tag,
          classification: record?.classification ?? null,
          detail: record?.reasons ?? ['no cadence record for this client'],
        });
      }
    }
  }

  if (input.tabCollision === true || tags.some((tag) => clients[tag]?.tabCollision === true)) {
    addReason(reasons, 'server-refused-tab-id', REFUSAL_SCOPE.tabCollision);
  }
  if (input.runDirectoryExists === true) addReason(reasons, 'run-directory-exists', REFUSAL_SCOPE.runDirectory);

  const start = input.originStart?.counters ?? input.originStart;
  const end = input.originEnd?.counters ?? input.originEnd;
  const unattributed = counterDelta(end, start, 'unattributedMediaBytesDelivered');
  if (finite(unattributed) && unattributed !== 0) {
    addReason(reasons, 'origin-unattributed-bytes-nonzero', REFUSAL_SCOPE.unattributed, { delta: unattributed });
  }

  if (Object.prototype.hasOwnProperty.call(input, 'publicationContext')) {
    const missing = missingFields('byte', { ...input.publicationContext, declaredClientTags: tags });
    if (missing) addReason(reasons, `required-context-absent:${missing}`, REFUSAL_SCOPE.publication, { field: missing, figure: 'byte' });
  }

  reasons.push(...evaluateByteControl({ bars, tags, figures: input.publicationContext ?? {} }));

  if (input.capacityStep && input.capacityStep.inForce === false) {
    addReason(reasons, 'capacity-step-not-in-force', REFUSAL_SCOPE.capacityStep, {
      declared: input.capacityStep.declared,
      readBack: input.capacityStep.readBack,
    });
  }
  for (const { reason, ...detail } of scheduleRefusals(input.capacitySchedule)) {
    addReason(reasons, reason, REFUSAL_SCOPE.capacityStep, detail);
  }

  if (condition.seek && input.seek) {
    if (!input.seek.host) {
      for (const tag of tags) {
        const lastReading = input.seek.lastReadings?.[tag] ?? input.seek.viewers?.[tag]?.reading ?? null;
        addReason(reasons, 'seek-not-applied', REFUSAL_SCOPE.seek, { tag, lastReading });
      }
    } else {
      if (Number.isSafeInteger(input.seek.declaredPositionMs)
        && (!finite(input.seek.landedPositionMs)
          || Math.abs(input.seek.landedPositionMs - input.seek.declaredPositionMs) > 2)) {
        addReason(reasons, 'seek-target-missed', REFUSAL_SCOPE.seek, {
          declaredPositionMs: input.seek.declaredPositionMs,
          landedPositionMs: input.seek.landedPositionMs ?? null,
        });
      }
      const landing = input.seek.landedOnHeldMedia ? input.seek : appliedSeekEvidence({
        host: input.seek.host,
        viewers: input.seek.viewers,
        peerRecords: input.peerRecords,
        declaredClientTags: tags,
        segmentSeconds: input.segmentSeconds,
        highDemandTimeWindowMs: input.seek.highDemandTimeWindowMs ?? Number(condition.engineWindows?.highDemandTimeWindow ?? 15) * 1000,
      });
      for (const entry of landing.notApplied ?? []) {
        addReason(reasons, 'seek-not-applied', REFUSAL_SCOPE.seek, {
          ...entry,
          lastReading: input.seek.lastReadings?.[entry.tag] ?? entry.lastReading ?? null,
        });
      }
      for (const entry of landing.landedOnHeldMedia ?? []) {
        addReason(reasons, 'seek-landed-on-held-media', REFUSAL_SCOPE.seek, entry);
      }
    }
  }

  const arm = armFor(condition);
  arm.refusals(input, (reason, scope, detail) => addReason(reasons, reason, scope, detail));
  const countedAsStall = [];
  for (const tag of tags) {
    const presentation = notPresenting(clientPolls(clients[tag] ?? {}), window);
    if (!presentation.counted) continue;
    const moved = moveCountedReasons(reasons, tag);
    countedAsStall.push({ tag, noFrameMs: presentation.noFrameMs, fromMs: presentation.fromMs, reasons: moved });
    noFrameMsByClient[tag] = presentation.noFrameMs;
    realtimeFactorByClient[tag] = countedRealtimeFactor(inWindow(clientRecords(clients[tag] ?? {}), window), window);
  }
  const excused = excusedByRosterEvent(condition, input.rosterEvent, reasons, clients);

  const summary = summarizeRefusalReasons(reasons);

  return {
    refused: summary.refused,
    runRefused: summary.runRefused,
    publicationRefused: summary.publicationRefused,
    reasons,
    excused,
    reasonSet: summary.reasonSet,
    duplicateReasons: summary.duplicateReasons,
    coverage,
    dropped,
    countedAsStall,
    published: { realtimeFactorByClient, noFrameMsByClient },
    unattributedDelta: unattributed,
    figures: summary.figures,
  };
}

export function refusalReasonSetIsUnique() {
  return new Set(REFUSAL_REASONS).size === REFUSAL_REASONS.length;
}
