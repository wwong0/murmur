import fs from 'node:fs';
import path from 'node:path';

/** Stamped on every capture line and on the verifier manifest, so a capture
 *  from before the product integration cannot pass for one of its runs. */
export const INTEGRATION_SCHEMA = 'drift-convergence-remedy/product-integration/1';
/** Events per drain call; the page queue holds far more, and a pump drains until empty. */
const TREATMENT_DRAIN_EVENTS = 512;
const TREATMENT_DRAIN_ROUNDS = 16;

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
    pitch: window.__app.pitch ? window.__app.pitch() : null,
  };
})()`;

export const TREATMENT_DRAIN = `(() => (window.__app && window.__app.treatmentEvidence)
  ? window.__app.treatmentEvidence(${TREATMENT_DRAIN_EVENTS})
  : null)()`;

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

/**
 * A capture keeps the fresh reading and a REFERENCE to the startup record by
 * its id: the record itself is written once to the treatment stream, so a
 * thousand reads of one setup are not a thousand setups.
 */
export function pitchReference(pitch) {
  if (!pitch || typeof pitch !== 'object') return null;
  return {
    startupId: pitch.startup?.id ?? null,
    current: pitch.current ?? null,
    treatment: pitch.treatment ?? null,
    f: pitch.f ?? null,
    controllerActive: pitch.controllerActive ?? null,
    fault: pitch.fault ?? null,
  };
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
    treatment: counts.treatment ? { ...counts.treatment } : null,
  };
}

/**
 * `treatment: true` also retains the page's opt-in treatment stream (the page
 * must be opened with treatmentEvidence=1) to `<label>.treatment.ndjson`: each
 * distinct startup record once, then every drained event in id order. A gap in
 * the ids is counted, never filled.
 */
export function createRecorder({ label, tab, dir, treatment = false }) {
  if (!label || !tab || !dir) throw new Error('createRecorder requires label, tab and dir');
  fs.mkdirSync(dir, { recursive: true });
  const recordsPath = path.join(dir, `${label}.records.ndjson`);
  const capturesPath = path.join(dir, `${label}.captures.ndjson`);
  const treatmentPath = treatment ? path.join(dir, `${label}.treatment.ndjson`) : null;
  const recordsFd = fs.openSync(recordsPath, 'w');
  const capturesFd = fs.openSync(capturesPath, 'w');
  const treatmentFd = treatment ? fs.openSync(treatmentPath, 'w') : null;
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
    treatment: treatment ? { startups: 0, eventsWritten: 0, firstId: null, lastId: null, gaps: 0, lost: 0, unavailable: 0, pendingAtLastDrain: 0 } : null,
  };
  const startupIds = new Set();
  let cursor = 0;
  let lastWrittenSeq = 0;
  let invariantError = null;
  let finished = false;

  const write = (fd, value) => fs.writeSync(fd, `${JSON.stringify(value)}\n`);

  async function drainTreatment(atMs) {
    for (let round = 0; round < TREATMENT_DRAIN_ROUNDS; round += 1) {
      const drained = await tab.evaluate(TREATMENT_DRAIN);
      if (!drained || !Array.isArray(drained.events)) {
        state.treatment.unavailable += 1;
        return;
      }
      for (const event of drained.events) {
        const expected = state.treatment.lastId === null ? 1 : state.treatment.lastId + 1;
        if (event.id !== expected) state.treatment.gaps += 1;
        write(treatmentFd, { kind: 'event', atMs, event });
        state.treatment.eventsWritten += 1;
        state.treatment.firstId ??= event.id;
        state.treatment.lastId = event.id;
      }
      state.treatment.lost = drained.lost;
      state.treatment.pendingAtLastDrain = drained.pending;
      if (drained.pending === 0) return;
    }
  }

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
      const startup = captured.pitch?.startup;
      if (treatmentFd !== null && startup?.id && !startupIds.has(startup.id)) {
        startupIds.add(startup.id);
        write(treatmentFd, { kind: 'startup', atMs, startup });
        state.treatment.startups += 1;
      }
      write(capturesFd, {
        atMs,
        schema: INTEGRATION_SCHEMA,
        buildId: captured.buildId ?? null,
        controller: captured.controller,
        clock: captured.clock,
        playback: captured.playback,
        pitch: pitchReference(captured.pitch),
      });
      state.capturesWritten += 1;
      const polls = captured.controller.polls;
      if (Number.isFinite(polls)) {
        state.firstPolls ??= polls;
        state.lastPolls = polls;
      }
      if (treatmentFd !== null) await drainTreatment(atMs);
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
      const fds = [recordsFd, capturesFd, ...(treatmentFd === null ? [] : [treatmentFd])];
      try {
        for (const fd of fds) fs.fsyncSync(fd);
      } finally {
        for (const fd of fds) fs.closeSync(fd);
        finished = true;
      }
    }
    if (invariantError) throw invariantError;
    return counts();
  }

  return { label, recordsPath, capturesPath, treatmentPath, pump, counts, finish };
}
