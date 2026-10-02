import fs from 'node:fs';
import path from 'node:path';

const finite = (value) => Number.isFinite(value);

export const CONTROL_POLL_INTERVAL_MS = 250;
export const RECORDING_TAIL_MS = 180_000;

export function hostPollExpression() {
  return `(() => {
    const pageMs = performance.timeOrigin + performance.now();
    const clock = __app.clock();
    return {
      pageMs,
      pageWallMs: Date.now(),
      clock,
      sharedMs: Number.isFinite(clock?.offsetMs) ? pageMs + clock.offsetMs : null,
      state: __app.playbackState(),
    };
  })()`;
}

export function viewerPollExpression() {
  return `(() => ({
    heldAhead: __app.heldAhead(),
    state: __app.playbackState(),
    clock: __app.clock(),
  }))()`;
}

function append(ndjson, name, records) {
  if (records.length) ndjson.append(name, records);
}

// The product's pace reading lists its ring under `intervals`, its resume
// reading under `records`; a recomputed pace input carries `intervals` too.
const drained = (reading) => reading?.records ?? reading?.intervals ?? [];

function readRecords(reading, cursor, kind) {
  if (!reading || typeof reading !== 'object') throw new Error(`${kind} evidence is unavailable`);
  const records = drained(reading);
  if (!Array.isArray(records)) throw new Error(`${kind} evidence is malformed`);
  let previous = cursor;
  for (const record of records) {
    if (!finite(record?.seq) || record.seq <= previous) {
      throw new RangeError(`${kind} evidence seq is not increasing`);
    }
    if (record.seq !== previous + 1) {
      throw new RangeError(`${kind} evidence seq gap: ${previous}->${record.seq}`);
    }
    previous = record.seq;
  }
  const latestSeq = Number(reading.latestSeq);
  return { records, latestSeq: finite(latestSeq) ? Math.max(previous, latestSeq) : previous };
}

function drainResult(reading, cursor, kind) {
  const evicted = Number(reading?.evicted ?? 0);
  if (!finite(evicted) || evicted < 0) throw new RangeError(`${kind} evidence evicted is invalid`);
  const parsed = readRecords(reading, cursor, kind);
  return { ...parsed, evicted };
}

export function evidenceRefusals({ hostPace, resumes, hostPoll = [], seek = null, peerExchange = true } = {}) {
  const refusals = [];
  const checkDrain = (reading, kind, evictedReason, gapReason) => {
    if (!reading) return;
    if (Number(reading.evicted) > 0) refusals.push({ reason: evictedReason, detail: { evicted: reading.evicted } });
    const records = drained(reading);
    let previous = 0;
    for (const record of records) {
      if (!finite(record?.seq) || record.seq <= previous || record.seq !== previous + 1) {
        refusals.push({ reason: gapReason, detail: { kind, previous, seq: record?.seq } });
        break;
      }
      previous = record.seq;
    }
  };
  checkDrain(hostPace, 'pace', 'pace-evidence-evicted', 'pace-evidence-seq-gap');
  checkDrain(resumes, 'resume', 'resume-evidence-evicted', 'resume-evidence-seq-gap');
  // Only a room with peer exchange holds; the drains above bind every host run.
  if (!peerExchange) return refusals;
  const first = hostPoll.find((poll) => poll?.state)?.state;
  if (hostPoll.length && first?.held !== true) {
    refusals.push({ reason: 'start-hold-unobserved', detail: { state: first ?? null } });
  }
  const resumeRecords = resumes?.records ?? resumes ?? [];
  for (const record of resumeRecords) {
    const later = hostPoll.filter((poll) => poll.state?.lineage === record.identity?.lineage
      && finite(poll.state?.version) && poll.state.version > record.identity?.version);
    const effective = later.some((poll) => poll.state.version === record.identity.version + 1);
    if (later.length && !effective) {
      refusals.push({ reason: 'resume-effective-unobserved', detail: { record } });
    }
  }
  if (seek?.host && seek.host.held !== true) {
    refusals.push({ reason: 'seek-hold-unobserved', detail: { host: seek.host } });
  }
  return refusals;
}

export function recordingEndForSeek({ join, seek, tailMs = RECORDING_TAIL_MS } = {}) {
  const sharedMs = Number(seek?.host?.atSharedMs ?? seek?.effectiveSharedMs);
  if (!finite(sharedMs) || !finite(join?.offsetMs) || !finite(tailMs) || tailMs < 0) return null;
  return sharedMs - join.offsetMs + tailMs;
}

export function recordingTailMs({ join, seek, windowEndMs, tailMs = RECORDING_TAIL_MS } = {}) {
  const endMs = recordingEndForSeek({ join, seek, tailMs });
  if (!finite(endMs) || !finite(windowEndMs)) return null;
  return Math.max(0, endMs - windowEndMs);
}

export function createControlEvidence({ hostSession, ndjson, runDir, now = () => Date.now() } = {}) {
  if (!hostSession?.tab || !ndjson) throw new TypeError('control evidence requires a host session and ndjson writer');
  const hostPoll = [];
  const viewerPolls = {};
  const pace = { records: [], evicted: 0, latestSeq: 0 };
  const resumes = { records: [], evicted: 0, latestSeq: 0 };
  let paceCursor = 0;
  let resumeCursor = 0;
  let lastPace = null;

  async function pollHost() {
    const harnessBeforeMs = now();
    const value = await hostSession.tab.evaluate(hostPollExpression());
    const harnessAfterMs = now();
    if (!value || !finite(value.pageMs) || !finite(value.pageWallMs)) throw new Error('host control poll is malformed');
    const entry = { harnessBeforeMs, harnessAfterMs, ...value };
    hostPoll.push(entry);
    ndjson.append('host-control-poll.ndjson', [entry]);
    // Null until the page has built its host origin: nothing to drain yet.
    const paceReading = await hostSession.tab.evaluate(`__app.hostPace(${paceCursor})`);
    if (paceReading !== null) {
      const paceResult = drainResult(paceReading, paceCursor, 'host pace');
      pace.evicted = Math.max(pace.evicted, paceResult.evicted);
      pace.records.push(...paceResult.records);
      pace.latestSeq = paceResult.latestSeq;
      paceCursor = paceResult.latestSeq;
      lastPace = paceReading;
      append(ndjson, 'host-pace.ndjson', paceResult.records);
    }
    const resumeReading = await hostSession.tab.evaluate(`__app.resumes(${resumeCursor})`);
    const resumeResult = drainResult(resumeReading, resumeCursor, 'host resume');
    resumes.evicted = Math.max(resumes.evicted, resumeResult.evicted);
    resumes.records.push(...resumeResult.records);
    resumes.latestSeq = resumeResult.latestSeq;
    resumeCursor = resumeResult.latestSeq;
    append(ndjson, 'host-resumes.ndjson', resumeResult.records);
    return entry;
  }

  async function pollViewer(session) {
    const harnessBeforeMs = now();
    const value = await session.tab.evaluate(viewerPollExpression());
    const harnessAfterMs = now();
    if (!value || typeof value !== 'object') throw new Error(`viewer control poll is malformed: ${session.tag}`);
    const entry = { harnessBeforeMs, harnessAfterMs, ...value };
    (viewerPolls[session.tag] ??= []).push(entry);
    ndjson.append(`viewer-control-${session.tag}.ndjson`, [entry]);
    return entry;
  }

  function finalize() {
    const final = lastPace ? {
      fraction: lastPace.fraction ?? null,
      estimate: lastPace.estimate ?? null,
      paceBytesPerSecond: lastPace.paceBytesPerSecond ?? null,
      intervals: pace.records,
      evicted: pace.evicted,
      latestSeq: pace.latestSeq,
      resumeEvicted: resumes.evicted,
      resumeLatestSeq: resumes.latestSeq,
      recordingEndHarnessMs: hostPoll.at(-1)?.harnessAfterMs ?? null,
    } : { fraction: null, estimate: null, paceBytesPerSecond: null, intervals: [], evicted: 0,
      latestSeq: 0, resumeEvicted: 0, resumeLatestSeq: 0,
      recordingEndHarnessMs: hostPoll.at(-1)?.harnessAfterMs ?? null };
    if (runDir) {
      fs.writeFileSync(path.join(runDir, 'host-pace-final.json'), `${JSON.stringify(final, null, 2)}\n`);
    }
    return { hostPoll, viewerPolls, hostPace: pace, resumes, hostPaceFinal: final,
      refusals: evidenceRefusals({ hostPace: pace, resumes, hostPoll }) };
  }

  return {
    hostPoll,
    viewerPolls,
    pollHost,
    pollViewer,
    finalize,
    snapshot: () => ({ hostPoll, viewerPolls, hostPace: pace, resumes }),
  };
}
