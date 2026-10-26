import { pollExpression } from './cdp-records.mjs';
import { issueRosterEvent as issueRosterEventFromRunner, rosterEventTarget } from './roster-event.mjs';
import { removesMember } from './roster-kinds.mjs';
import { supplierReadingExpression, waitForSupplier } from './supplier-cut.mjs';

// The loop dependencies are bound once per run; each call names only its session.
export function createSessionLoops({ startLoop, loops, state, ndjson, arm, queuedDrain, controlEvidence, askEvidence,
  pollIntervalMs, drainIntervalMs }) {
  const failOnError = (session) => (error) => { if (!session.expectedEvent) state.failure ??= error; };
  return {
    startControlLoop(session) {
      if (!controlEvidence || session.controlLoop) return;
      const viewerPoll = startLoop(async () => { await controlEvidence.pollViewer(session); await askEvidence.drain(session); },
        250, failOnError(session));
      session.controlLoop = viewerPoll;
      loops.push(viewerPoll);
    },
    startMeasureLoops(session) {
      if (session.measureLoops?.length) return;
      const poll = startLoop(async () => {
        const value = await session.tab.evaluate(pollExpression());
        session.polls.push(value);
        ndjson.append(`client-${session.tag}.poll.ndjson`, [value]);
      }, pollIntervalMs, failOnError(session));
      const drain = startLoop(() => queuedDrain(session, ndjson, arm, Date.now()), drainIntervalMs, failOnError(session));
      session.measureLoops = [poll, drain];
      loops.push(poll, drain);
    },
  };
}

export async function stopSessionLoops(session, { keepControl = false } = {}) {
  for (const loop of session.measureLoops ?? []) loop.stop();
  if (!keepControl) session.controlLoop?.stop();
  await Promise.all([...(session.measureLoops ?? []), ...(keepControl ? [] : [session.controlLoop])]
    .filter(Boolean).map((loop) => loop.promise.catch(() => {})));
  session.measureLoops = [];
  if (!keepControl) session.controlLoop = null;
}

export async function setupSessions({ sessions, heldTag, room, clientOriginUrl, deadline, clientFactory, condition, runDir,
  arm, manifestFile, prepareClient, startEcho, qualifyFirst, beginLinkQualification, activeSessions, failedCdpQualification, state,
  sessionLoops }) {
  const clientUrlFor = (session) => `${clientOriginUrl}/room.html?room=${encodeURIComponent(room)}&role=${session.role}&tab=${session.tag}`;
  const activateHeldJoiner = async (session) => {
    await prepareClient(session, clientUrlFor(session), deadline, arm.clientReadyTimeoutMs(condition), arm.prepareClientOptions({
      condition, manifestFile, runDir,
    }));
    session.active = true;
    sessionLoops.startControlLoop(session);
    sessionLoops.startMeasureLoops(session);
    await startEcho(session);
    return { navigated: true, pageReadyMs: session.pageReadyMs };
  };
  for (const [index, session] of sessions.entries()) {
    const clientUrl = clientUrlFor(session);
    const acquired = await clientFactory({ tag: session.tag, role: session.role, room, url: clientUrl, condition, runDir });
    Object.assign(session, acquired);
    if (session.tag === heldTag) continue;
    if (index === 0 && !session.tab) {
      manifestFile.merge({ cdpQualification: failedCdpQualification('qualification-unavailable:first-client-tab') });
      manifestFile.write();
      throw new Error('first client tab is unavailable for CDP qualification');
    }
    await prepareClient(session, clientUrl, deadline, arm.clientReadyTimeoutMs(condition), arm.prepareClientOptions({
      condition,
      manifestFile,
      runDir,
    }));
    session.active = true;
    sessionLoops.startControlLoop(session);
    if (index === 0 && !arm.qualifyAfterJoins) await qualifyFirst();
    // Not awaited: the joins go on while the first viewer's fetch is in flight.
    if (index === 0 && arm.qualifyAfterJoins) {
      state.pendingQualification = Promise.resolve(arm.beginQualification(activeSessions(), {
        beginLinkQualification, segmentSeconds: manifestFile.get().content?.segmentSeconds,
      }));
      state.pendingQualification.catch(() => {});
    }
    if (!arm.qualifyAfterJoins) await startEcho(session);
  }
  // 8b design.md D3 (i): the host arm's room starts once its roster has been still
  // for 2 s, so its viewers all join before the first's qualification is collected.
  if (arm.qualifyAfterJoins) {
    state.lastJoinAtMs = Date.now();
    await qualifyFirst();
    for (const session of activeSessions()) await startEcho(session);
  }
  return { activateHeldJoiner };
}

/** The schedule edge's issue: a condition with no rosterEvent records its edge and issues nothing. */
export function edgeRosterEvent(options, issue = issueRosterEvent) {
  return options.condition?.rosterEvent ? async (edge) => issue({ ...options, client: edge.leaver }) : null;
}

export async function issueRosterEvent({ client = null, condition, topology, sessions, room, runDir, heldTag,
  activateHeldJoiner, stopSessionLoops, state, manifestFile, segmentSeconds,
  waitForSupplierImpl = waitForSupplier }) {
  const kind = condition.rosterEvent?.kind;
  let targetTag = client ?? rosterEventTarget(condition, kind);
  let selection = null;
  if (kind === 'leave-supplier-silent') {
    const seconds = segmentSeconds ?? manifestFile?.get?.().content?.segmentSeconds;
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('supplier cut needs segment seconds');
    const viewers = sessions.filter((session) => session.active === true && session.role === 'viewer');
    selection = await waitForSupplierImpl({
      read: async () => Object.fromEntries(await Promise.all(viewers.map(async (session) => [
        session.tag, await session.tab.evaluate(supplierReadingExpression(seconds)),
      ]))),
    });
    targetTag = selection.victim;
  }
  const target = sessions.find((session) => session.tag === targetTag);
  if (!target && selection?.victim !== null) throw new Error(`roster event target is unavailable: ${targetTag}`);
  if (!target && kind !== 'leave-supplier-silent') throw new Error(`roster event target is unavailable: ${targetTag}`);
  if (!target) {
    state.rosterEvent = await issueRosterEventFromRunner({ condition, topology, sessions, targetSession: null, room,
      client: null, kind, runDir, selection });
    return state.rosterEvent;
  }
  target.expectedEvent = true;
  state.rosterEvent = await issueRosterEventFromRunner({ condition, topology, sessions, targetSession: target, room,
    client: targetTag, runDir,
    ...(kind === 'leave-supplier-silent' ? { selection } : {}),
    activateJoin: targetTag === heldTag ? activateHeldJoiner : undefined,
    // Waited for: a call in flight when the browser exits never settles, and teardown awaits every loop.
    stopSession: ['leave-clean', 'leave-first'].includes(kind)
      ? (session) => stopSessionLoops(session)
      : undefined,
    disposeSession: () => target.dispose?.(),
  });
  // A joiner is in the room from here on, and in both boundaries.
  if (removesMember(kind)) target.active = false;
  return state.rosterEvent;
}
