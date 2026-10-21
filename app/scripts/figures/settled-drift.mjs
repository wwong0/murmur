import { median } from '../../public/lib/frame-drift.mjs';
import { frameStalls } from './frame-stalls.mjs';
import { harnessSharedMs, latestPagePoll, pagePollSharedMs } from './poll-coverage.mjs';

const finite = (value) => Number.isFinite(value);
const toShared = (timebase, value) => (finite(value) ? harnessSharedMs(timebase, value, value) : null);
const unreadable = (reason) => ({ status: 'unreadable', reason, settledAtSharedMs: null, windows: [] });

function modesIn(polls, startMs, endMs, pagePolls) {
  const inside = polls.filter((poll) => poll.atMs >= startMs && poll.atMs < endMs).map((poll) => poll.mode);
  const modes = inside.length ? inside : [latestPagePoll(pagePolls, startMs)?.controller?.mode ?? null];
  return modes.filter((mode, index) => index === 0 || mode !== modes[index - 1]).filter((mode) => mode !== null);
}

function skipOver(pagePolls, startMs, spanMs) {
  const before = latestPagePoll(pagePolls, startMs)?.playback?.skips;
  const after = latestPagePoll(pagePolls, startMs + spanMs)?.playback?.skips;
  return Number.isSafeInteger(before) && Number.isSafeInteger(after) ? after > before : null;
}

function readTag({ startShared, endShared, pagePolls, records, hostPoll, gapMs, thresholdMs, spanMs }) {
  const polls = (pagePolls ?? []).map((poll) => ({ atMs: pagePollSharedMs(poll), mode: poll.controller?.mode ?? null }))
    .filter((poll) => finite(poll.atMs) && poll.atMs >= startShared && poll.atMs <= endShared)
    .sort((left, right) => left.atMs - right.atMs);
  if (!polls.length) return unreadable('poll-window-empty');
  const settledAt = polls.find((poll) => poll.mode === 'settled')?.atMs;
  if (!finite(settledAt)) return { status: 'never-settled', settledAtSharedMs: null, windows: [] };
  if (!Array.isArray(records)) return unreadable('drift-stream-missing');
  const stalls = frameStalls({ records, playing: hostPoll, fromMs: settledAt, toMs: endShared, gapMs });
  if (stalls.status !== 'ok') return unreadable(stalls.reason);
  const windows = [];
  let windowsRead = 0;
  for (let start = settledAt; start + spanMs <= endShared; start += spanMs) {
    windowsRead += 1;
    const values = records.filter((record) => finite(record?.displaySharedMs) && finite(record.driftMs)
      && record.displaySharedMs >= start && record.displaySharedMs < start + spanMs)
      .map((record) => record.driftMs).sort((left, right) => left - right);
    const medianDriftMs = values.length ? median(values) : null;
    if (!(Math.abs(medianDriftMs) > thresholdMs)) continue;
    const skip = skipOver(pagePolls, start, spanMs);
    windows.push({ startSharedMs: start, afterSettledMs: start - settledAt, afterWindowStartMs: start - startShared,
      medianDriftMs, records: values.length, modes: modesIn(polls, start, start + spanMs, pagePolls),
      stall: stalls.stalls.some((stall) => stall.startMs < start + spanMs && stall.startMs + stall.lengthMs > start),
      skip, skipEvidence: skip === null ? 'unavailable' : 'measured' });
  }
  return { status: 'settled', settledAtSharedMs: settledAt, settledAfterWindowStartMs: settledAt - startShared,
    windowsRead, windowsExceeding: windows.length, windows };
}

/** Read each viewer's 1 000 ms windows from its settled instant to the window's end. */
export function settledDrift({ tags = [], window, timebase, drift, pagePolls, hostPoll, gapMs = 250,
  thresholdMs = 40, spanMs = 1000 } = {}) {
  const startShared = toShared(timebase, window?.startMs);
  const endShared = toShared(timebase, window?.endMs);
  if (!finite(startShared) || !finite(endShared)) return { row: 'settled-drift', status: 'unreadable', reason: 'window-unavailable' };
  const byClient = Object.fromEntries(tags.map((tag) => [tag, readTag({ startShared, endShared,
    pagePolls: pagePolls?.[tag], records: drift?.[tag], hostPoll, gapMs, thresholdMs, spanMs })]));
  const shownBy = Object.entries(byClient).flatMap(([tag, client]) => (client.windows ?? [])
    .filter((entry) => entry.stall === false && entry.skip === false).map((entry) => ({ tag, startSharedMs: entry.startSharedMs })));
  const unreadableTag = Object.entries(byClient).find(([, client]) => client.status === 'unreadable')?.[0];
  const skipBlind = Object.values(byClient).some((client) => (client.windows ?? [])
    .some((entry) => entry.stall === false && entry.skip === null));
  const shown = shownBy.length ? true : unreadableTag || skipBlind ? null : false;
  return { row: 'settled-drift', status: 'published', thresholdMs, spanMs, windowStartSharedMs: startShared,
    windowEndSharedMs: endShared, byClient, shown, shownBy,
    ...(shown === null ? { shownReason: unreadableTag ? `unreadable:${unreadableTag}` : 'skip-evidence-unavailable' } : {}) };
}
