const SEGMENT_RE = /seg-(\d+)\.m4s$/;

const finite = (value) => Number.isFinite(value);

const segmentIndex = (value) => {
  const match = typeof value === 'string' ? value.match(SEGMENT_RE) : null;
  return match ? Number(match[1]) : null;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function supplierReadingExpression(segmentSeconds) {
  if (!finite(segmentSeconds) || segmentSeconds <= 0) throw new Error('segment seconds must be positive');
  return `(() => {
    const wallMs = Date.now();
    const video = document.querySelector('video');
    const bytes = typeof __app.peerBytes === 'function' ? __app.peerBytes(0) : null;
    const open = Array.isArray(bytes?.open) ? bytes.open
      .filter((entry) => entry?.source === 'http')
      .map((entry) => ({ attemptId: entry.attemptId, path: entry.path, startMs: entry.startMs,
        endMs: null, end: null, bytes: entry.bytesSoFar ?? null, source: 'http', open: true })) : [];
    const records = Array.isArray(bytes?.records) ? bytes.records
      .filter((entry) => entry?.kind === 'attempt' && entry.source === 'http'
        && Number.isFinite(entry.endMs) && entry.endMs >= wallMs - 10000)
      .map((entry) => ({ attemptId: entry.attemptId, path: entry.path, startMs: entry.startMs,
        endMs: entry.endMs, end: entry.end, bytes: entry.bytes, source: 'http', open: false })) : [];
    return {
      wallMs,
      playheadSegment: video && Number.isFinite(video.currentTime)
        ? Math.floor(video.currentTime / ${JSON.stringify(segmentSeconds)}) : null,
      attempts: [...open, ...records],
    };
  })()`;
}
function playheadOf(reading) {
  return finite(reading?.playheadSegment) ? reading.playheadSegment : null;
}

function activeAttempt(attempt, wallMs) {
  if (attempt?.open === true) return true;
  return finite(wallMs) && finite(attempt?.endMs)
    && attempt.endMs <= wallMs && wallMs - attempt.endMs <= 10_000;
}

export function chooseSupplier(readings = {}) {
  const playheads = Object.fromEntries(Object.entries(readings ?? {}).map(([tag, reading]) => [tag, playheadOf(reading)]));
  const candidates = [];
  for (const [tag, reading] of Object.entries(readings ?? {})) {
    for (const attempt of Array.isArray(reading?.attempts) ? reading.attempts : []) {
      const index = segmentIndex(attempt?.path);
      if (attempt?.source !== 'http' || index === null || !activeAttempt(attempt, reading?.wallMs)) continue;
      const aboveEveryOtherPlayhead = Object.entries(playheads)
        .filter(([other]) => other !== tag)
        .every(([, playhead]) => playhead === null || index > playhead);
      if (aboveEveryOtherPlayhead) candidates.push({ tag, index, path: attempt.path, attempt });
    }
  }
  candidates.sort((left, right) => right.index - left.index || left.tag.localeCompare(right.tag));
  const winner = candidates[0] ?? null;
  return {
    victim: winner?.tag ?? null,
    segment: winner ? { index: winner.index, path: winner.path } : null,
    attempt: winner?.attempt ?? null,
    candidates,
    playheads,
  };
}

export async function waitForSupplier({ read, now = Date.now, sleep: wait = sleep,
  maxMs = 30_000, everyMs = 1_000 } = {}) {
  if (typeof read !== 'function') throw new Error('supplier reader is required');
  const startedAt = now();
  const deadline = startedAt + maxMs;
  const reads = [];
  let lastChoice = { victim: null, segment: null, attempt: null, candidates: [], playheads: {} };
  while (true) {
    const value = await read();
    reads.push(value);
    lastChoice = chooseSupplier(value);
    if (lastChoice.victim !== null) return { ...lastChoice, reads };
    const remaining = deadline - now();
    if (remaining <= 0) return { ...lastChoice, reason: 'no-active-supplier', reads };
    await wait(Math.min(everyMs, remaining));
  }
}
