import { maxRateEvidence } from './start-requalification.mjs';

const finite = (value) => Number.isFinite(value);
const integer = (value) => Number.isSafeInteger(value);
const controllerOf = (poll) => poll?.controller ?? poll ?? {};
const playbackOf = (poll) => poll?.playback ?? {};

function row(rowName, status, figures = {}) {
  return { row: rowName, status, ...figures };
}

function declaredDisturbance(condition, disturbance) {
  const result = disturbance?.results?.c03 ?? disturbance ?? {};
  return {
    ...result,
    observationMs: result.observationMs ?? condition?.disturbance?.observationMs,
  };
}

function observationWindow(disturbance, polls) {
  const startMs = disturbance?.playResolvedLocalMs;
  const endMs = finite(disturbance?.pauseCallLocalMs) && finite(disturbance?.observationMs)
    ? disturbance.pauseCallLocalMs + disturbance.observationMs : NaN;
  if (!finite(startMs) || !finite(endMs)) return Array.isArray(polls) ? polls : [];
  return polls.filter((poll) => finite(poll?.atMs) && poll.atMs >= startMs && poll.atMs <= endMs);
}

function valueAt(poll, field) {
  const playback = playbackOf(poll);
  return playback[field] ?? poll?.[field];
}

function skipAt(poll) {
  const value = valueAt(poll, 'skips');
  return integer(value) && value >= 0 ? value : null;
}

function firstCorrecting(polls, disturbance) {
  const startMs = disturbance?.playResolvedLocalMs;
  const startIndex = finite(startMs) ? polls.findIndex((poll) => poll.atMs >= startMs) : 0;
  for (let index = Math.max(0, startIndex); index < polls.length; index += 1) {
    const controller = controllerOf(polls[index]);
    if (controller.mode === 'correcting' || controller.rate === 1.01) return { poll: polls[index], index };
  }
  return null;
}

function excessFromSpread(poll) {
  const controller = controllerOf(poll);
  const estimateMs = controller.estimateMs;
  const bandMs = controller.bandMs;
  return finite(estimateMs) && finite(bandMs) ? Math.abs(estimateMs) - bandMs : NaN;
}

function rateRun(polls, first) {
  const begin = first ? polls.findIndex((poll, index) => index >= first.index && controllerOf(poll).rate === 1.01) : -1;
  if (begin < 0) return { polls: [], firstNonUnityPoll: null, endPoll: null };
  const run = [];
  let endPoll = null;
  for (let index = begin; index < polls.length; index += 1) {
    const poll = polls[index];
    if (excessFromSpread(poll) < 40) {
      endPoll = poll;
      break;
    }
    run.push(poll);
  }
  return {
    polls: run,
    firstNonUnityPoll: run.find((poll) => controllerOf(poll).rate !== 1.01) ?? null,
    endPoll,
  };
}

function pairRecords(pair) {
  if (Array.isArray(pair)) return pair;
  if (Array.isArray(pair?.records)) return pair.records;
  if (Array.isArray(pair?.samples)) return pair.samples;
  return [];
}

function sampleTime(sample) {
  return sample?.atMs ?? sample?.displaySharedMs ?? sample?.sharedMs ?? sample?.timeMs;
}

function sampleValue(sample) {
  if (finite(sample?.medianAbsDriftMs)) return Math.abs(sample.medianAbsDriftMs);
  if (finite(sample?.absDriftMs)) return Math.abs(sample.absDriftMs);
  if (finite(sample?.driftMs)) return Math.abs(sample.driftMs);
  if (finite(sample?.drift)) return Math.abs(sample.drift);
  return NaN;
}

function median(values) {
  const sorted = values.filter(finite).sort((left, right) => left - right);
  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function windowMedian(pair, startMs, windowMs) {
  const values = pairRecords(pair)
    .filter((sample) => finite(sampleTime(sample)) && sampleTime(sample) >= startMs && sampleTime(sample) <= startMs + windowMs)
    .map(sampleValue);
  return { value: median(values), count: values.filter(finite).length };
}

/** Return the elapsed shared time at which every pair stays within the bar. */
export function resyncAfter({ firstFrameSharedMs, pairs, windowMs, medianMaxMs, holdMs } = {}) {
  if (!finite(firstFrameSharedMs) || !Array.isArray(pairs) || !pairs.length
    || !(finite(windowMs) && windowMs > 0) || !(finite(medianMaxMs) && medianMaxMs >= 0)
    || !(finite(holdMs) && holdMs >= 0)) return null;
  const normalized = pairs.map(pairRecords);
  if (normalized.some((pair) => !pair.length)) return null;
  const candidates = [...new Set(normalized.flatMap((pair) => pair
    .map(sampleTime).filter((time) => finite(time) && time >= firstFrameSharedMs)))].sort((a, b) => a - b);
  const allTimes = [...new Set(normalized.flatMap((pair) => pair
    .map(sampleTime).filter((time) => finite(time) && time >= firstFrameSharedMs)))].sort((a, b) => a - b);
  const settledAt = (startMs) => {
    const endMs = startMs + holdMs;
    const checks = [startMs, ...allTimes.filter((time) => time > startMs && time <= endMs)];
    return checks.every((time) => normalized.every((pair) => {
      const reading = windowMedian(pair, time, windowMs);
      return reading.count > 0 && reading.value <= medianMaxMs;
    }));
  };
  const candidate = candidates.find((time) => settledAt(time));
  return candidate === undefined ? null : candidate - firstFrameSharedMs;
}

function recordsFor(client) {
  if (Array.isArray(client)) return client;
  return Array.isArray(client?.records) ? client.records : [];
}

function pollsFor(client) {
  if (Array.isArray(client)) return client;
  return Array.isArray(client?.polls) ? client.polls : [];
}

function startsFor(client) {
  if (Array.isArray(client)) return client;
  return Array.isArray(client?.starts) ? client.starts : [];
}

function pairInputs(records, others, firstFrameSharedMs) {
  if (Array.isArray(others?.pairs)) return others.pairs;
  const clients = Array.isArray(others)
    ? Object.fromEntries(others.map((client, index) => [client?.tag ?? `other-${index}`, client]))
    : (others && typeof others === 'object' ? others : {});
  const source = records.filter((record) => finite(record?.displaySharedMs) && record.displaySharedMs >= firstFrameSharedMs);
  return Object.values(clients).map((client) => {
    const otherRecords = recordsFor(client);
    return source.map((record) => {
      let nearest = null;
      for (const candidate of otherRecords) {
        if (!finite(candidate?.displaySharedMs)) continue;
        if (!nearest || Math.abs(candidate.displaySharedMs - record.displaySharedMs)
          < Math.abs(nearest.displaySharedMs - record.displaySharedMs)) nearest = candidate;
      }
      return nearest && finite(nearest.driftMs) && finite(record.driftMs)
        ? { atMs: record.displaySharedMs, driftMs: record.driftMs - nearest.driftMs } : null;
    }).filter(Boolean);
  });
}

function residualFigures(starts, records) {
  return starts.map((start, index) => {
    const nextAfterSeq = starts[index + 1]?.afterSeq ?? Infinity;
    const values = records.filter((record) => integer(record?.seq) && record.seq > start?.afterSeq
      && record.seq <= nextAfterSeq && finite(record.driftMs)).slice(0, 24).map((record) => record.driftMs);
    const medianMs = median(values);
    return {
      attemptId: start?.attemptId ?? null,
      medianMs: finite(medianMs) ? medianMs : null,
      count: values.length,
      reprojections: start?.reprojections ?? null,
      coverElapsedMs: start?.coverElapsedMs ?? null,
      reparks: start?.reparks ?? null,
    };
  });
}

export function behindReading({ condition = {}, disturbance, polls, records, starts, others } = {}) {
  const declared = declaredDisturbance(condition, disturbance);
  const injected = declared.injected === true;
  const caseName = condition.behind?.case;
  const pollList = Array.isArray(polls) ? polls : null;
  const recordList = Array.isArray(records) ? records : null;
  const observedPolls = pollList ? observationWindow(declared, pollList) : [];
  const skipValues = observedPolls.map(skipAt).filter((value) => value !== null);
  const firstSkipValue = skipValues[0] ?? null;
  const lastSkipValue = skipValues.at(-1) ?? null;
  const skipRise = firstSkipValue !== null && lastSkipValue !== null ? lastSkipValue - firstSkipValue : null;
  const firstSkip = observedPolls.find((poll, index) => index > 0 && skipAt(poll) !== null
    && skipAt(observedPolls[index - 1]) !== null && skipAt(poll) > skipAt(observedPolls[index - 1]));
  const first = firstCorrecting(observedPolls, declared);
  const run = rateRun(observedPolls, first);
  const saturatedMinPolls = Number(condition.behind?.saturatedMinPolls ?? 80);
  const settled = first ? observedPolls.find((poll, index) => index > first.index && controllerOf(poll).mode === 'settled') : null;
  const saturated = injected && pollList && recordList
    ? maxRateEvidence({ records: recordList, polls: pollList, disturbance: declared, bars: condition.bars }) : null;
  const rows = [];

  if (caseName === 'inside') {
    let status = !injected ? 'not-exercised' : (!pollList || !recordList ? 'evidence-failure'
      : first && finite(controllerOf(first.poll).fastestCloseMs) && controllerOf(first.poll).fastestCloseMs <= 60000
        && saturated?.qualifyingSaturated >= 1 ? 'met' : 'missed');
    rows.push(row('B1', status, {
      qualifyingSaturated: saturated?.qualifyingSaturated ?? null,
      fastestCloseMs: finite(controllerOf(first?.poll).fastestCloseMs) ? controllerOf(first.poll).fastestCloseMs : null,
      firstCorrectingAtMs: first?.poll?.atMs ?? null,
    }));

    status = !injected || !first ? 'not-exercised' : !pollList ? 'evidence-failure'
      : run.polls.length < saturatedMinPolls ? 'not-exercised' : run.firstNonUnityPoll ? 'missed' : 'met';
    rows.push(row('B2', status, {
      saturatedPolls: run.polls.length,
      saturatedMinPolls,
      firstNonUnityPoll: run.firstNonUnityPoll ? {
        atMs: run.firstNonUnityPoll.atMs,
        rate: controllerOf(run.firstNonUnityPoll).rate,
      } : null,
      firstNonUnityPollAtMs: run.firstNonUnityPoll?.atMs ?? null,
      endPollAtMs: run.endPoll?.atMs ?? null,
    }));

    const allowance = condition.behind?.settleAllowanceMs;
    const settleBound = finite(controllerOf(first?.poll).fastestCloseMs) && finite(allowance)
      ? controllerOf(first.poll).fastestCloseMs + allowance : NaN;
    const settlingMs = settled && first ? settled.atMs - first.poll.atMs : null;
    status = !injected || !first ? 'not-exercised' : !pollList ? 'evidence-failure'
      : !settled ? 'missed' : finite(settleBound) && finite(settlingMs) && settlingMs <= settleBound ? 'met' : 'missed';
    rows.push(row('B3', status, { settlingMs, settleBoundMs: finite(settleBound) ? settleBound : null, settledAtMs: settled?.atMs ?? null }));

    status = !injected ? 'not-exercised' : !pollList || skipValues.length < 2 ? 'evidence-failure'
      : firstSkipValue === lastSkipValue ? 'met' : 'missed';
    rows.push(row('B4', status, { firstSkips: firstSkipValue, lastSkips: lastSkipValue, skipDelta: skipRise }));
  }

  if (caseName === 'past') {
    const pauseMs = Number(condition.disturbance?.pauseMs);
    const skipDecisionMaxMs = Number(condition.behind?.skipDecisionMaxMs);
    const abandonedToleranceMs = Number(condition.behind?.abandonedToleranceMs);
    const abandoned = firstSkip ? valueAt(firstSkip, 'lastSkipAbandonedMs') : null;
    const decisionMs = firstSkip && finite(declared.playResolvedLocalMs) ? firstSkip.atMs - declared.playResolvedLocalMs : NaN;
    let status;
    if (!injected) status = 'not-exercised';
    else if (!pollList || skipValues.length < 2 || skipValues.some((value) => value === null)) status = 'evidence-failure';
    else if (skipRise !== 1) status = 'missed';
    else if (!finite(abandoned) || !finite(pauseMs) || !finite(decisionMs)) status = 'evidence-failure';
    else status = decisionMs >= 0 && decisionMs <= skipDecisionMaxMs && abandoned < 0
      && Math.abs(abandoned + pauseMs) <= abandonedToleranceMs ? 'met' : 'missed';
    rows.push(row('B5', status, {
      skipDelta: skipRise,
      skipDecisionMs: finite(decisionMs) ? decisionMs : null,
      skipDecisionMaxMs,
      lastSkipAbandonedMs: finite(abandoned) ? abandoned : null,
      abandonedErrorMs: finite(abandoned) && finite(pauseMs) ? Math.abs(abandoned + pauseMs) : null,
    }));

    const b5Met = rows.at(-1).status === 'met';
    const startList = Array.isArray(starts) ? starts : null;
    const skipStart = startList?.find((start) => start && start.skipOf !== undefined && start.skipOf !== null) ?? null;
    const openValues = observedPolls.map((poll) => valueAt(poll, 'opens')).filter((value) => value !== undefined);
    const fallbackOpens = [declared.playbackBefore?.opens, declared.playbackAfter?.opens].filter((value) => value !== undefined);
    const opens = openValues.length ? openValues : fallbackOpens;
    const startLatenessMaxMs = Number(condition.behind?.startLatenessMaxMs ?? 600);
    status = !b5Met ? 'not-exercised' : !startList || !skipStart ? 'evidence-failure'
      : !finite(skipStart.latenessMs) || !integer(skipStart.reparks) || skipStart.reparks !== 0
        || opens.length < 2 || opens[0] !== opens.at(-1) || skipStart.latenessMs > startLatenessMaxMs ? 'missed' : 'met';
    rows.push(row('B6', status, {
      skipStart: skipStart ? {
        skipOf: skipStart.skipOf,
        latenessMs: skipStart.latenessMs,
        reparks: skipStart.reparks,
        startAtSharedMs: skipStart.startAtSharedMs ?? null,
        playAtSharedMs: skipStart.playAtSharedMs ?? null,
      } : null,
      opensFirst: opens[0] ?? null,
      opensLast: opens.at(-1) ?? null,
      startLatenessMaxMs,
    }));

    const b6Met = rows.at(-1).status === 'met';
    if (!b6Met) rows.push(row('B7', 'not-exercised'));
    else {
      const firstFrame = recordList?.find((record) => integer(record?.seq) && record.seq > skipStart.afterSeq
        && finite(record.displaySharedMs));
      const resync = condition.behind?.resync ?? {};
      const lastMs = firstFrame ? firstFrame.displaySharedMs + resync.maxMs + resync.holdMs + resync.windowMs : NaN;
      const pairs = firstFrame ? pairInputs(recordList.filter((record) => !(record?.displaySharedMs > lastMs)), others,
        firstFrame.displaySharedMs) : [];
      const requiredOthers = Math.max(0, Number(condition.clients ?? 5) - 1);
      const suppliedOthers = others && typeof others === 'object' ? Object.keys(others.pairs ? {} : others).length : 0;
      const hasStreams = pairs.length >= requiredOthers && pairs.every((pair) => pairRecords(pair)
        .some((sample) => finite(sampleTime(sample)) && sampleTime(sample) <= firstFrame.displaySharedMs + 32000));
      const resyncMs = firstFrame && hasStreams ? resyncAfter({
        firstFrameSharedMs: firstFrame.displaySharedMs,
        pairs,
        windowMs: condition.behind?.resync?.windowMs,
        medianMaxMs: condition.behind?.resync?.medianMaxMs,
        holdMs: condition.behind?.resync?.holdMs,
      }) : null;
      rows.push(row('B7', !recordList || !firstFrame || suppliedOthers < requiredOthers || !hasStreams
        ? 'evidence-failure' : resyncMs !== null && resyncMs <= condition.behind.resync.maxMs ? 'met' : 'missed', {
        firstFrameSharedMs: firstFrame?.displaySharedMs ?? null,
        resyncAfterMs: resyncMs,
        resyncMaxMs: condition.behind?.resync?.maxMs ?? null,
      }));
    }

    if (!b5Met) rows.push(row('B8', 'not-exercised'));
    else {
      const fields = ['skips', 'opens', 'begun', 'reparks', 'retargets'];
      const tags = Object.keys(others ?? {}).filter((key) => key !== 'pairs');
      const expectedTags = Array.from({ length: Number(condition.clients ?? 5) }, (_, index) => `c${String(index + 1).padStart(2, '0')}`).filter((tag) => tag !== 'c03');
      const clientsPresent = expectedTags.every((tag) => tags.includes(tag));
      const stable = clientsPresent && expectedTags.every((tag) => {
        const clientPolls = observationWindow(declared, pollsFor(others[tag]));
        const firstPoll = clientPolls[0];
        const lastPoll = clientPolls.at(-1);
        return firstPoll && lastPoll && fields.every((field) => valueAt(firstPoll, field) !== undefined
          && Object.is(valueAt(firstPoll, field), valueAt(lastPoll, field)));
      });
      const c03Moved = firstSkipValue !== lastSkipValue;
      rows.push(row('B8', !clientsPresent ? 'evidence-failure' : stable && c03Moved ? 'met' : 'missed', {
        unchangedClients: expectedTags,
        c03SkipMoved: c03Moved,
      }));
    }
  }

  if (caseName !== 'inside' && caseName !== 'past') return rows;
  if (!injected) rows.push(row('B9', 'not-exercised'));
  else if (!recordList || !Array.isArray(starts)) rows.push(row('B9', 'evidence-failure'));
  else {
    const clients = { c03: { starts, records: recordList }, ...(others ?? {}) };
    const perClient = Object.fromEntries(Object.entries(clients).map(([tag, client]) => [tag,
      residualFigures(startsFor(client), recordsFor(client))]));
    const allStarts = Object.values(perClient).flat();
    const malformed = allStarts.some((start) => start.reprojections === null || start.reparks === null);
    rows.push(row('B9', !allStarts.length || malformed ? 'evidence-failure' : 'met', {
      startResidualsByClient: perClient,
      shortStarts: allStarts.filter((start) => start.count < 24).length,
    }));
  }
  return rows;
}
