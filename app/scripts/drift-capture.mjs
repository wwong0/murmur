import fs from 'node:fs';
import path from 'node:path';

function sequenceForExpression(afterSeq) {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new Error(`invalid drift cursor: ${afterSeq}`);
  }
  return String(afterSeq);
}

export function recordsReadExpression(afterSeq = 0) {
  const cursor = sequenceForExpression(afterSeq);
  return `(() => {
  if (!window.__app) return { present: false, records: [], missed: 0, latestSeq: 0, counters: null };
  const drift = window.__app.drift(${cursor});
  return {
    present: true,
    records: drift.records,
    missed: drift.missed,
    latestSeq: drift.latestSeq,
    counters: drift.counters,
  };
})()`;
}

export const STATE_CAPTURE = `(() => {
  if (!window.__app) return { present: false };
  return {
    present: true,
    buildId: window.__app.buildId,
    controller: window.__app.controller(),
    clock: window.__app.clock(),
    playback: window.__app.playback(),
  };
})()`;

function checkedRecordsRead(read) {
  if (!read || typeof read !== 'object' || typeof read.present !== 'boolean') {
    throw new Error('drift records read has no present flag');
  }
  if (!read.present) return null;
  if (!Array.isArray(read.records)) throw new Error('drift records read did not return an array');
  if (!Number.isSafeInteger(read.latestSeq) || read.latestSeq < 0) {
    throw new Error('drift records read has an invalid latestSeq');
  }
  if (!Number.isSafeInteger(read.missed) || read.missed < 0) {
    throw new Error('drift records read has an invalid missed count');
  }
  if (!read.counters || typeof read.counters !== 'object') {
    throw new Error('drift records read has no counters object');
  }
  return read;
}

function checkedStateCapture(state) {
  if (!state || typeof state !== 'object' || typeof state.present !== 'boolean') {
    throw new Error('drift state capture has no present flag');
  }
  if (!state.present) return null;
  if (!state.controller || typeof state.controller !== 'object') {
    throw new Error('drift state capture has no controller snapshot');
  }
  if (!state.clock || typeof state.clock !== 'object') {
    throw new Error('drift state capture has no clock estimate');
  }
  if (!state.playback || typeof state.playback !== 'object') {
    throw new Error('drift state capture has no playback state');
  }
  return state;
}

function copyCounts(counts) {
  return {
    recordsWritten: counts.recordsWritten,
    capturesWritten: counts.capturesWritten,
    missed: counts.missed,
    firstSeq: counts.firstSeq,
    lastSeq: counts.lastSeq,
    firstPolls: counts.firstPolls,
    lastPolls: counts.lastPolls,
    absentReads: counts.absentReads,
    errors: counts.errors,
    lastError: counts.lastError,
  };
}

export function createRecorder({ label, tab, dir }) {
  if (!label || !tab || !dir) throw new Error('createRecorder requires label, tab and dir');
  fs.mkdirSync(dir, { recursive: true });
  const recordsPath = path.join(dir, `${label}.records.ndjson`);
  const capturesPath = path.join(dir, `${label}.captures.ndjson`);
  const recordsFd = fs.openSync(recordsPath, 'w');
  const capturesFd = fs.openSync(capturesPath, 'w');
  const state = {
    recordsWritten: 0,
    capturesWritten: 0,
    missed: 0,
    firstSeq: null,
    lastSeq: null,
    firstPolls: null,
    lastPolls: null,
    absentReads: 0,
    errors: 0,
    lastError: null,
  };
  let cursor = 0;
  let lastWrittenSeq = 0;
  let invariantError = null;
  let finished = false;

  const write = (fd, value) => fs.writeSync(fd, `${JSON.stringify(value)}\n`);

  async function pump(atMs) {
    if (finished) throw new Error(`${label} recorder is already finished`);
    try {
      if (!Number.isFinite(atMs)) throw new Error(`${label} pump needs a finite timestamp`);
      const read = checkedRecordsRead(await tab.evaluate(recordsReadExpression(cursor)));
      if (read === null) {
        state.absentReads += 1;
        return { present: false, records: 0, capture: false };
      }
      if (read.latestSeq < cursor) throw new Error(`${label} drift cursor moved backwards`);
      for (const record of read.records) {
        if (!record || !Number.isSafeInteger(record.seq) || record.seq <= lastWrittenSeq) {
          throw new Error(`${label} duplicate or invalid record sequence at ${record?.seq ?? 'null'}`);
        }
        write(recordsFd, record);
        lastWrittenSeq = record.seq;
        state.recordsWritten += 1;
        state.firstSeq ??= record.seq;
        state.lastSeq = record.seq;
      }
      if (read.records.length > 0 && read.records.at(-1).seq > read.latestSeq) {
        throw new Error(`${label} latestSeq precedes its newest record`);
      }
      cursor = read.latestSeq;
      state.missed += read.missed;

      const captured = checkedStateCapture(await tab.evaluate(STATE_CAPTURE));
      if (captured === null) {
        state.absentReads += 1;
        return { present: false, records: read.records.length, capture: false };
      }
      write(capturesFd, {
        atMs,
        buildId: captured.buildId ?? null,
        controller: captured.controller,
        clock: captured.clock,
        playback: captured.playback,
      });
      state.capturesWritten += 1;
      const polls = captured.controller.polls;
      if (Number.isFinite(polls)) {
        state.firstPolls ??= polls;
        state.lastPolls = polls;
      }
      return { present: true, records: read.records.length, capture: true };
    } catch (error) {
      state.errors += 1;
      state.lastError = error?.message ?? String(error);
      if (/duplicate or invalid record sequence/.test(state.lastError)) invariantError = error;
      return { present: false, records: 0, capture: false, error: state.lastError };
    }
  }

  function counts() {
    return copyCounts(state);
  }

  function finish() {
    if (!finished) {
      try {
        fs.fsyncSync(recordsFd);
        fs.fsyncSync(capturesFd);
      } finally {
        fs.closeSync(recordsFd);
        fs.closeSync(capturesFd);
        finished = true;
      }
    }
    if (invariantError) throw invariantError;
    return counts();
  }

  return { label, recordsPath, capturesPath, pump, counts, finish };
}
