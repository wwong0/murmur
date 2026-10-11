import { POLL_FRESH_MS } from './poll-coverage.mjs';

const finite = (value) => Number.isFinite(value);

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function failure(reason, detail = {}) {
  return { status: 'evidence-failure', reason, distanceBehindMs: null, ...detail };
}

function hostGapAcross(hostPolls, atMs) {
  const values = (hostPolls ?? []).map((poll) => poll?.sharedMs).filter(finite).sort((left, right) => left - right);
  const before = values.filter((value) => value <= atMs).at(-1);
  const after = values.find((value) => value >= atMs);
  if (!finite(before) || !finite(after)) {
    return { gapMs: Infinity, fromMs: finite(before) ? before : null, toMs: finite(after) ? after : null };
  }
  return { gapMs: after - before, fromMs: before, toMs: after };
}

/** Negate the viewer's shared-clock drift median; negative drift means behind. */
export function distanceBehind({ records, atMs, windowMs, minRecords, lastPollAtMs, hostPolls,
  pollGapMaxMs = POLL_FRESH_MS } = {}) {
  if (!Array.isArray(records)) return failure('drift-stream-missing');
  if (!(finite(atMs) && finite(windowMs) && windowMs > 0 && Number.isSafeInteger(minRecords) && minRecords > 0)) {
    return failure('distance-window-invalid');
  }
  const startMs = atMs - windowMs;
  const samples = records.filter((record) => finite(record?.displaySharedMs)
    && record.displaySharedMs >= startMs && record.displaySharedMs <= atMs);
  if (samples.some((record) => !finite(record?.driftMs))) return failure('drift-record-malformed');
  if (lastPollAtMs !== undefined && !finite(lastPollAtMs)) {
    return { status: 'unreadable', reason: 'viewer-poll-gap', distanceBehindMs: null,
      pollGapMs: Infinity, pollGapMaxMs, records: samples.length };
  }
  if (atMs - lastPollAtMs > pollGapMaxMs) {
    return { status: 'unreadable', reason: 'viewer-poll-gap', distanceBehindMs: null,
      pollGapMs: atMs - lastPollAtMs, pollGapMaxMs, records: samples.length };
  }
  if (Array.isArray(hostPolls)) {
    const hostGap = hostGapAcross(hostPolls, atMs);
    if (hostGap.gapMs > pollGapMaxMs) {
      return { status: 'unreadable', reason: 'host-poll-gap', hostPollGap: hostGap,
        pollGapMaxMs, distanceBehindMs: null, records: samples.length };
    }
  }
  if (samples.length < minRecords) {
    return { status: 'missed', reason: 'not-presenting', distanceBehindMs: null,
      records: samples.length, minRecords };
  }
  const driftMedianMs = median(samples.map((record) => record.driftMs));
  return { status: 'available', distanceBehindMs: -driftMedianMs, driftMedianMs,
    records: samples.length, window: { startMs, endMs: atMs } };
}

function viewerPollSharedMs(poll, timebase) {
  if (!finite(timebase?.offsetMs) || !finite(poll?.harnessBeforeMs) || !finite(poll?.harnessAfterMs)) return null;
  return (poll.harnessBeforeMs + poll.harnessAfterMs) / 2 + timebase.offsetMs;
}

function pagePollSharedMs(poll) {
  if (!finite(poll?.atMs) || !finite(poll?.clock?.offsetMs)) return null;
  return poll.atMs + poll.clock.offsetMs;
}

function latestViewerPoll(polls, atMs, timebase) {
  return (polls ?? []).map((poll) => ({ poll, atMs: viewerPollSharedMs(poll, timebase) }))
    .filter((entry) => finite(entry.atMs) && entry.atMs <= atMs)
    .sort((left, right) => left.atMs - right.atMs).at(-1) ?? null;
}

function latestPagePoll(polls, atMs) {
  return (polls ?? []).map((poll) => ({ poll, atMs: pagePollSharedMs(poll) }))
    .filter((entry) => finite(entry.atMs) && entry.atMs <= atMs)
    .sort((left, right) => left.atMs - right.atMs).at(-1)?.poll ?? null;
}

function counterReading(poll) {
  const playback = poll?.playback;
  if (!playback || typeof playback !== 'object') return null;
  const fields = ['opens', 'begun', 'retargets', 'reparks', 'skips'];
  if (fields.some((field) => !Number.isSafeInteger(playback[field]))) return null;
  return Object.fromEntries(fields.map((field) => [field, playback[field]]));
}

function skipReading(polls, atMs) {
  const poll = latestPagePoll(polls, atMs);
  return { atMs: poll ? pagePollSharedMs(poll) : null, skips: Number.isSafeInteger(poll?.playback?.skips) ? poll.playback.skips : null };
}

/** Build G1 rows at a shared-clock recovered-span end. */
export function distanceBehindRows({ condition = {}, clients = {}, viewerPolls = {}, pagePolls = {},
  hostPoll = [], atMs, timebase, capacitySchedule } = {}) {
  const criteria = condition.reading?.criteria?.distanceBehind ?? {};
  const maxMs = criteria.maxMs;
  const windowMs = criteria.windowMs;
  const minRecords = criteria.minRecords;
  const pollGapMaxMs = criteria.pollGapMaxMs ?? POLL_FRESH_MS;
  const tags = Object.keys(clients);
  const dropHarnessMs = capacitySchedule?.drop?.readBackAtMs;
  const dropSharedMs = finite(dropHarnessMs) && finite(timebase?.offsetMs)
    ? dropHarnessMs + timebase.offsetMs : null;
  const rows = tags.map((tag) => {
    const polls = viewerPolls[tag];
    const base = { row: 'G1', client: tag, distanceBehindMs: null, maxMs,
      pollPositionMs: null, pollAtMs: null, pollApproximate: true };
    if (!Array.isArray(polls) || !polls.length) return { ...base, status: 'evidence-failure', reason: 'viewer-poll-stream-missing' };
    if (!Array.isArray(hostPoll) || !hostPoll.length) return { ...base, status: 'evidence-failure', reason: 'host-poll-stream-missing' };
    if (!finite(timebase?.offsetMs)) return { ...base, status: 'evidence-failure', reason: 'timebase-offset-missing' };

    const latest = latestViewerPoll(polls, atMs, timebase);
    const lastPollAtMs = latest?.atMs ?? null;
    const reading = distanceBehind({ records: clients[tag]?.records, atMs, windowMs, minRecords,
      lastPollAtMs, hostPolls: hostPoll, pollGapMaxMs });
    const distance = reading.distanceBehindMs;
    const status = reading.status === 'available'
      ? (finite(maxMs) && finite(distance) && Math.abs(distance) <= maxMs ? 'met' : 'missed')
      : reading.status;
    const poll = latest?.poll;
    const result = { ...base, ...reading, status,
      pollPositionMs: finite(poll?.state?.positionMs) ? poll.state.positionMs : null,
      pollAtMs: finite(lastPollAtMs) ? lastPollAtMs : null };

    const page = pagePolls[tag];
    if (!Array.isArray(page) || !page.length) {
      return { ...result, status: 'evidence-failure', reason: 'page-poll-stream-missing',
        skipsAtDrop: null, skipsAtInstant: null, skipRise: null };
    }
    if (!finite(dropSharedMs)) {
      return { ...result, status: 'evidence-failure', reason: 'capacity-drop-readback-missing',
        skipsAtDrop: null, skipsAtInstant: null, skipRise: null };
    }
    const atReading = skipReading(page, atMs);
    const dropReading = skipReading(page, dropSharedMs);
    if (![dropReading.skips, atReading.skips].every(Number.isSafeInteger)) {
      return { ...result, status: 'evidence-failure', reason: 'skip-counter-missing',
        skipsAtDrop: dropReading.skips, skipsAtInstant: atReading.skips, skipRise: null };
    }
    return { ...result, skipsAtDrop: dropReading.skips, skipsAtInstant: atReading.skips,
      skipAtDropMs: dropReading.atMs, skipAtInstantMs: atReading.atMs,
      skipRise: atReading.skips - dropReading.skips };
  });
  const status = rows.some((entry) => entry.status === 'evidence-failure') ? 'evidence-failure'
    : rows.some((entry) => entry.status === 'unreadable') ? 'unreadable'
      : rows.every((entry) => entry.status === 'met') ? 'met' : 'missed';
  return { status, rows, maxMs, atMs };
}
