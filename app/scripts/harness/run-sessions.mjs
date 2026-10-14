import { pollExpression } from './cdp-records.mjs';
import { issueRosterEvent as issueRosterEventFromRunner, rosterEventTarget } from './roster-event.mjs';
import { removesMember } from './roster-kinds.mjs';

export function startControlLoop({ session, controlEvidence, askEvidence, startLoop, loops, state }) {
  if (!controlEvidence || session.controlLoop) return;
  const viewerPoll = startLoop(async () => { await controlEvidence.pollViewer(session); await askEvidence.drain(session); },
    250, (error) => { if (!session.expectedEvent) state.failure ??= error; });
  session.controlLoop = viewerPoll;
  loops.push(viewerPoll);
}

export function startMeasureLoops({ session, startLoop, loops, state, ndjson, arm, queuedDrain, pollIntervalMs, drainIntervalMs }) {
  if (session.measureLoops?.length) return;
  const poll = startLoop(async () => {
    const value = await session.tab.evaluate(pollExpression());
    session.polls.push(value);
    ndjson.append(`client-${session.tag}.poll.ndjson`, [value]);
  }, pollIntervalMs, (error) => { if (!session.expectedEvent) state.failure ??= error; });
  const drain = startLoop(() => queuedDrain(session, ndjson, arm, Date.now()), drainIntervalMs,
    (error) => { if (!session.expectedEvent) state.failure ??= error; });
  session.measureLoops = [poll, drain];
  loops.push(poll, drain);
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
  arm, manifestFile, prepareClient, startEcho, qualifyFirst, beginLinkQualification, activeSessions, failedCdpQualification, state, loops,
  controlEvidence, askEvidence, startLoop, ndjson, queuedDrain, pollIntervalMs, drainIntervalMs }) {
  const clientUrlFor = (session) => `${clientOriginUrl}/room.html?room=${encodeURIComponent(room)}&role=${session.role}&tab=${session.tag}`;
  const activateHeldJoiner = async (session) => {
    await prepareClient(session, clientUrlFor(session), deadline, arm.clientReadyTimeoutMs(condition), arm.prepareClientOptions({
      condition, manifestFile, runDir,
    }));
    session.active = true;
    startControlLoop({ session, controlEvidence, askEvidence, startLoop, loops, state });
    startMeasureLoops({ session, startLoop, loops, state, ndjson, arm, queuedDrain, pollIntervalMs, drainIntervalMs });
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
    startControlLoop({ session, controlEvidence, askEvidence, startLoop, loops, state });
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

export async function issueRosterEvent({ client = null, condition, topology, sessions, room, runDir, heldTag,
  activateHeldJoiner, stopSessionLoops, state }) {
  const kind = condition.rosterEvent?.kind;
  const targetTag = client ?? rosterEventTarget(condition, kind);
  const target = sessions.find((session) => session.tag === targetTag);
  if (!target) throw new Error(`roster event target is unavailable: ${targetTag}`);
  target.expectedEvent = true;
  state.rosterEvent = await issueRosterEventFromRunner({ condition, topology, sessions, targetSession: target, room,
    client: targetTag, runDir,
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
