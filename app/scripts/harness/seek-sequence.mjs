// The seek a condition declares, as the runner performs and records it: step the
// capacity, issue the seek, wait for the room to apply it, and build seek.json at
// each of its three stages. Nothing here writes; the runner owns the manifest.

import { appliedSeekEvidence } from '../figures/seek-evidence.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function stepThenSeek({ condition, topology, preSeekState = null, readHostState,
  stepQdisc, seek, drainAll = async () => {}, now = Date.now } = {}) {
  const seekDeclaration = condition?.seek;
  if (!seekDeclaration) return { capacityStep: null, seek: null };
  let capacityStep = null;
  if (condition.capacityStep) {
    await drainAll();
    const stepAtMs = now();
    const readBackResult = await (stepQdisc ?? ((value) => topology.stepQdisc({ capacityStep: value })))(condition.capacityStep);
    await drainAll();
    const readBackAtMs = now();
    capacityStep = {
      declared: condition.capacityStep,
      before: null,
      readBack: readBackResult?.readings ?? {},
      stepAtMs,
      readBackAtMs,
      inForce: readBackResult?.matches === true,
    };
    if (!capacityStep.inForce) return { capacityStep, seek: null };
  }
  const before = preSeekState ?? await readHostState?.();
  if (!before) throw new Error('host playback state is unavailable before seek');
  await drainAll();
  const result = await seek(seekDeclaration.deltaMs);
  // Harness clock, as readBackAtMs is; the page's instant is another machine's clock.
  const seekIssuedAtMs = now();
  await drainAll();
  if (!result || result.issued !== true) throw new Error('harness seek was not issued');
  return {
    capacityStep,
    seek: {
      declared: seekDeclaration,
      before,
      seekIssuedAtMs,
      pageIssuedAtMs: Number.isFinite(result.atPageMs) ? result.atPageMs : null,
      issued: true,
    },
  };
}

export async function waitForAppliedSeek({ sessions = [], hostSession, before, timeoutMs, readState,
  drainAll = async () => {}, now = Date.now, sleepFn = sleep, pollIntervalMs = 125 } = {}) {
  if (!before || !Number.isInteger(before.version) || typeof before.lineage !== 'string') {
    throw new Error('host playback state before seek is invalid');
  }
  const all = [hostSession, ...sessions].filter(Boolean);
  const lastReadings = {};
  const matchedAtMs = {};
  const deadline = now() + timeoutMs;
  const read = readState ?? ((session) => session.tab.evaluate('__app.playbackState()'));
  while (true) {
    const atMs = now();
    for (const session of all) {
      const reading = await read(session);
      lastReadings[session.tag] = reading;
    }
    const host = lastReadings[hostSession?.tag];
    const hostApplied = host?.lineage === before.lineage
      && Number.isInteger(host.version) && host.version > before.version;
    if (hostApplied) {
      // `held` is the host's own reading and is not matched against viewers:
      // the control figures require it of a seek's held state (8b2 T3 item 8).
      const expected = { lineage: host.lineage, version: host.version, playing: host.playing, positionMs: host.positionMs, atSharedMs: host.atSharedMs,
        ...(typeof host.held === 'boolean' ? { held: host.held } : {}) };
      const applied = (reading) => reading?.lineage === expected.lineage && reading.version === expected.version
        && reading.playing === expected.playing && reading.positionMs === expected.positionMs
        && reading.atSharedMs === expected.atSharedMs;
      for (const session of sessions) {
        const reading = lastReadings[session.tag];
        if (!matchedAtMs[session.tag] && applied(reading)) matchedAtMs[session.tag] = { atMs, reading };
      }
      const viewers = Object.fromEntries(sessions.map((session) => [session.tag, matchedAtMs[session.tag] ?? null]));
      const allApplied = sessions.every((session) => applied(lastReadings[session.tag]));
      if (allApplied) return { host: expected, hostAtMs: atMs, viewers, timedOut: false, lastReadings };
      if (now() >= deadline) return { host: expected, hostAtMs: atMs, viewers, timedOut: true, lastReadings };
    }
    await drainAll();
    if (now() >= deadline) break;
    await sleepFn(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }
  return { host: null, hostAtMs: null, viewers: {}, timedOut: true, lastReadings };
}

export function capacityBeforeReadings(manifest, capacityStep) {
  const record = (manifest.topology?.qdiscs ?? []).find((entry) =>
    entry.containerRole === capacityStep.container && entry.discipline === capacityStep.discipline);
  return record?.readBack?.readings ?? {};
}

function restartEvidence(boundary, effectiveSharedMs) {
  const starts = boundary?.playback?.starts ?? [];
  const candidate = starts.find((start) => Number.isFinite(start.firstStartAtSharedMs)
    && start.firstStartAtSharedMs >= effectiveSharedMs);
  if (candidate && Number.isFinite(candidate.startAtSharedMs) && candidate.startAtSharedMs < effectiveSharedMs) {
    throw new Error('restart-start-before-effective-shared-time');
  }
  if (!candidate) return { restarted: false };
  return {
    restarted: true,
    latenessMs: candidate.latenessMs,
    reparks: candidate.reparks,
    startAtSharedMs: candidate.startAtSharedMs,
    positionMs: candidate.positionMs,
  };
}

function landingFor(seekEvidence, sessions, { segmentSeconds, highDemandTimeWindowMs }) {
  return appliedSeekEvidence({
    host: seekEvidence.host,
    viewers: seekEvidence.viewers,
    peerRecords: Object.fromEntries(sessions.map((session) => [session.tag, session.peerRecords ?? []])),
    declaredClientTags: sessions.map((session) => session.tag),
    segmentSeconds,
    highDemandTimeWindowMs,
  });
}

// Stage one: what was issued and who applied it, before any segment is read.
export function issuedSeekEvidence(issued, applied, sessions) {
  return {
    ...issued,
    issuedAtMs: issued.seekIssuedAtMs,
    host: applied.host,
    hostAtMs: applied.hostAtMs,
    viewers: Object.fromEntries(sessions.map((session) => [session.tag, {
      reading: applied.viewers[session.tag]?.reading ?? null,
      appliedAtMs: applied.viewers[session.tag]?.atMs ?? null,
    }])),
    lastReadings: applied.lastReadings,
    applied: applied.timedOut === false,
  };
}

// Stage two: where it landed against what each viewer held when it took effect. A
// seek the host never applied has no landing.
export function landedSeekEvidence(seekEvidence, sessions, windows) {
  return {
    ...seekEvidence,
    ...(seekEvidence.host ? landingFor(seekEvidence, sessions, windows) : {}),
    landingMs: seekEvidence.host?.positionMs ?? null,
    effectiveSharedMs: seekEvidence.host?.atSharedMs ?? null,
  };
}

// Stage three, at the end boundary: the held segments read again from the complete
// peer records, and whether each viewer restarted.
export function restartedSeekEvidence(seekEvidence, sessions, endSnapshots) {
  const landing = landingFor(seekEvidence, sessions, seekEvidence);
  const viewers = Object.fromEntries(sessions.map((session) => {
    const current = seekEvidence.viewers[session.tag] ?? {};
    const refreshed = landing.viewers[session.tag] ?? {};
    return [session.tag, {
      ...current,
      restart: restartEvidence(endSnapshots[session.tag], seekEvidence.host.atSharedMs),
      highestSegmentBeforeE: refreshed.highestSegmentBeforeE,
      heldSegments: refreshed.heldSegments,
      kL: landing.landingSegment,
    }];
  }));
  return { ...seekEvidence, ...landing, viewers,
    viewersNotRestarted: Object.keys(viewers).filter((tag) => viewers[tag].restart.restarted === false) };
}
