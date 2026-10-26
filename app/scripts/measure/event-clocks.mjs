import { harnessSharedMs, pagePollSharedMs, sharedWallMs } from '../figures/poll-coverage.mjs';
import { gapToOthers, gridRows, holdFrom, labRecords, stallsBetween } from './lab-position.mjs';

const finite = (value) => Number.isFinite(value);

function joinReading(evidence) {
  const event = evidence.rosterEvent;
  const tag = event?.client;
  const entry = event?.presence?.recvSharedMs;
  if (event?.kind !== 'join') return { applicable: false };
  if (!tag || !finite(entry)) return { section: 'unreadable', reason: 'join-entry-unavailable' };
  const first = labRecords(evidence, tag).filter((row) => row.record.displaySharedMs >= entry)[0];
  if (!first) return { section: 'unreadable', reason: 'no-first-frame', entrySharedMs: entry,
    entryToFirstFrameMs: null, firstFrameToInSyncMs: null, entryToInSyncMs: null };
  const others = (evidence.tags ?? []).filter((other) => other !== tag);
  const base = gridRows(evidence, [tag, ...others], first.L, Math.max(first.L, ...others.flatMap((other) => labRecords(evidence, other).map((row) => row.L))));
  if (!base) return { section: 'unreadable', reason: 'frame-rate-unavailable', entrySharedMs: entry };
  const sync = holdFrom(gapToOthers(base, tag, others), first.L);
  if (!finite(sync)) return { section: 'readable', reason: 'not-within-observation', entrySharedMs: entry,
    firstFrameSharedMs: first.record.displaySharedMs, entryToFirstFrameMs: first.record.displaySharedMs - entry,
    firstFrameToInSyncMs: null, entryToInSyncMs: null };
  const nearest = labRecords(evidence, tag).slice().sort((left, right) => Math.abs(left.L - sync) - Math.abs(right.L - sync))[0];
  const offset = nearest?.record?.clock?.offsetMs;
  return { section: 'readable', entrySharedMs: entry, firstFrameSharedMs: first.record.displaySharedMs,
    inSyncLabMs: sync, entryToFirstFrameMs: first.record.displaySharedMs - entry,
    firstFrameToInSyncMs: sync - first.L, entryToInSyncMs: finite(offset) ? sync + offset - entry : null };
}
function sourceFor(record, attempts, peerTags) {
  const kept = (record?.keptAttemptIds ?? []).map((id) => attempts.find((attempt) => attempt.attemptId === id)).filter(Boolean);
  if (!kept.length) return 'not-completed';
  if (kept.some((attempt) => attempt.source === 'http')) return 'host';
  const peer = kept.find((attempt) => attempt.source === 'p2p');
  if (!peer) return 'unknown-peer';
  return peerTags.find((tag) => tag.peerId && tag.peerId === peer.peerId)?.tag ?? 'unknown-peer';
}
function pollStalls(evidence, tag, cutMs) {
  const rows = (evidence.clients?.[tag]?.polls ?? []).map((poll) => ({ poll, atMs: pagePollSharedMs(poll) ?? poll?.atMs }))
    .filter((row) => finite(row.atMs) && row.atMs >= cutMs && row.atMs <= cutMs + 60_000).sort((a, b) => a.atMs - b.atMs);
  const counts = rows.map((row) => row.poll?.stalls?.count).filter(Number.isSafeInteger);
  return { ...stallsBetween(evidence.clients?.[tag]?.drift, cutMs, cutMs + 60_000),
    stallCountDelta: counts.length ? counts.at(-1) - counts[0] : null };
}
function supplierCut(evidence) {
  const event = evidence.rosterEvent;
  if (event?.kind !== 'leave-supplier-silent') return { applicable: false };
  if (event.victim === null || event.victim === undefined) return { section: 'unreadable', reason: 'no-active-supplier' };
  const cutMs = harnessSharedMs(evidence.timebase, event.issuedAtHarnessMs, event.issuedAtHarnessMs);
  const selection = event.selection ?? {};
  if (!finite(cutMs)) return { section: 'unreadable', reason: 'cut-instant-unavailable', victim: event.victim, selection };
  const path = selection.segment?.path;
  const victimClient = evidence.clients?.[event.victim];
  const victimAttempts = (victimClient?.peerBytes ?? []).filter((record) => record.kind === 'attempt' && record.source === 'http' && record.path === path);
  const victimVerified = victimAttempts.some((record) => {
    const start = sharedWallMs(evidence.timebase, record.startMs);
    const end = sharedWallMs(evidence.timebase, record.endMs);
    return finite(start) && start <= cutMs && (!finite(end) || end >= cutMs - 10_000);
  });
  const indexes = finite(selection.segment?.index) ? [selection.segment.index, selection.segment.index + 1, selection.segment.index + 2] : [];
  const remaining = (evidence.tags ?? []).filter((tag) => tag !== event.victim);
  const peerTags = (evidence.tags ?? []).map((tag) => ({ tag, peerId: evidence.manifest?.clients?.[tag]?.peerId }));
  const replacement = Object.fromEntries(remaining.map((tag) => {
    const attempts = (evidence.clients?.[tag]?.peerBytes ?? []).filter((record) => record.kind === 'attempt');
    const byIndex = Object.fromEntries(indexes.map((index) => {
      const segment = (evidence.clients?.[tag]?.peerBytes ?? []).find((record) => record.kind === 'segment' && Number(record.path?.match(/\/seg-(\d+)\.m4s$/)?.[1]) === index);
      return [index, sourceFor(segment, attempts, peerTags)];
    }));
    return [tag, byIndex];
  }));
  const stalls = Object.fromEntries(remaining.map((tag) => [tag, pollStalls(evidence, tag, cutMs)]));
  return { section: 'readable', victim: event.victim, selection, cutSharedMs: cutMs, victimVerified, replacement, stalls };
}

export function eventClocks(evidence) {
  return { reader: 'event-clocks', version: 1, run: evidence.run ?? null,
    join: joinReading(evidence), supplierCut: supplierCut(evidence) };
}
