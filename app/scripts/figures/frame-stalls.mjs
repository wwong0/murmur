const finite = (value) => Number.isFinite(value);
const integer = (value) => Number.isSafeInteger(value);

function failure(reason, detail = {}) {
  return { status: 'evidence-failure', reason, ...detail };
}

function activeOf(sample) {
  const state = sample?.state;
  if (!state || typeof state !== 'object') return null;
  if (state.playing === false || state.held === true) return false;
  if (state.playing === true) return true;
  return null;
}

function playingSamples(playing) {
  if (!Array.isArray(playing)) return [];
  return playing.map((sample) => ({ atMs: sample?.sharedMs, active: activeOf(sample) }))
    .filter((sample) => finite(sample.atMs) && sample.active !== null)
    .sort((left, right) => left.atMs - right.atMs);
}

function activeRanges(startMs, endMs, samples) {
  if (!(endMs > startMs)) return [];
  const points = [startMs, endMs, ...samples.map((sample) => sample.atMs)
    .filter((atMs) => atMs > startMs && atMs < endMs)];
  const sorted = [...new Set(points)].sort((left, right) => left - right);
  const ranges = sorted.slice(1).map((end, index) => {
    const begin = sorted[index];
    const state = samples.filter((sample) => sample.atMs <= begin).at(-1)?.active ?? true;
    return state ? { startMs: begin, endMs: end } : null;
  }).filter(Boolean);
  return ranges.reduce((merged, range) => {
    const previous = merged.at(-1);
    if (previous && previous.endMs === range.startMs) previous.endMs = range.endMs;
    else merged.push({ ...range });
    return merged;
  }, []);
}

function appendGap(stalls, startMs, endMs, gapMs, samples) {
  for (const range of activeRanges(startMs, endMs, samples)) {
    if (range.endMs - range.startMs > gapMs) {
      stalls.push({ startMs: range.startMs, lengthMs: range.endMs - range.startMs });
    }
  }
}

/** Read shared-clock frame gaps while excluding held or paused stretches. */
export function frameStalls({ records, playing, fromMs, toMs, gapMs } = {}) {
  if (!Array.isArray(records)) return failure('drift-stream-missing');
  if (!(finite(fromMs) && finite(toMs) && toMs >= fromMs && finite(gapMs) && gapMs >= 0)) {
    return failure('stall-window-invalid');
  }
  const relevant = records.filter((record) => finite(record?.displaySharedMs)
    && record.displaySharedMs >= fromMs && record.displaySharedMs <= toMs)
    .slice().sort((left, right) => left.displaySharedMs - right.displaySharedMs);
  if (!relevant.length) return failure('drift-stream-empty');

  for (const record of relevant) {
    if (!integer(record?.presentedFrames)) return failure('presented-frame-counter-missing');
    if (!integer(record?.seq)) return failure('drift-sequence-missing');
  }

  let uncalledFrames = 0;
  for (let index = 1; index < relevant.length; index += 1) {
    const previous = relevant[index - 1];
    const current = relevant[index];
    const presentedDelta = current.presentedFrames - previous.presentedFrames;
    if (presentedDelta < 1) {
      return failure('presented-frame-counter-invalid', { atMs: current.displaySharedMs });
    }
    if (current.seq - previous.seq !== 1) {
      return failure('drift-record-lost', { atMs: current.displaySharedMs });
    }
    uncalledFrames += Math.max(0, presentedDelta - 1);
  }

  const samples = playingSamples(playing);
  const stalls = [];
  appendGap(stalls, fromMs, relevant[0].displaySharedMs, gapMs, samples);
  for (let index = 1; index < relevant.length; index += 1) {
    appendGap(stalls, relevant[index - 1].displaySharedMs, relevant[index].displaySharedMs, gapMs, samples);
  }
  appendGap(stalls, relevant.at(-1).displaySharedMs, toMs, gapMs, samples);
  stalls.sort((left, right) => left.startMs - right.startMs);
  return { status: 'ok', stalls, uncalledFrames };
}
