import fs from 'node:fs';
import path from 'node:path';
import { asyncExec } from '../../harness/apply-qdisc.mjs';
import { clientTags } from './arms.mjs';

export function rosterEventTarget(condition = {}, kind = condition.rosterEvent?.kind) {
  if (kind === 'join') return condition.rosterEvent?.client ?? 'c05';
  if (kind === 'leave-first' || kind === 'leave-supplier-silent') return null;
  return condition.rosterEvent?.client ?? 'c03';
}

export function isHeldJoin(condition = {}) {
  return condition.rosterEvent?.kind === 'join' && typeof condition.rosterEvent.client === 'string';
}

function othersFor(condition, tag) {
  return clientTags(condition).filter((candidate) => candidate !== tag);
}

function recordsOf(session) {
  return session?.presenceRecorder?.snapshot?.() ?? session?.presenceRecords ?? [];
}

function latestMemberId(session) {
  const records = recordsOf(session).filter((record) => record?.tabId === session?.tag
    && typeof record.clientId === 'string');
  return records.at(-1)?.clientId ?? null;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function setInterfaceDown({ topology, tag, exec = asyncExec } = {}) {
  const state = topology?.state ?? {};
  const container = state.containers?.[tag];
  const ifName = state.mediaDefaultRoute?.[tag]?.ifName ?? state.origin?.ifName;
  if (!container || !ifName) throw new Error(`media interface is unavailable for ${tag}`);
  await exec(['docker', 'exec', container, 'ip', 'link', 'set', 'dev', ifName, 'down']);
  const readBack = await exec(['docker', 'exec', container, 'ip', '-json', 'link', 'show', 'dev', ifName]);
  let link;
  try { link = JSON.parse(readBack)?.[0] ?? null; } catch { link = null; }
  return { container, ifName, readBack: link, down: link?.operstate === 'DOWN' || link?.flags?.includes?.('DOWN') };
}

async function terminateSocket({ topology, room, tabId, exec = asyncExec } = {}) {
  const container = topology?.state?.containers?.server;
  if (!container) throw new Error('server container is unavailable for socket control');
  const request = "fetch('http://127.0.0.1:8190/terminate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({room:process.argv[1],tabId:process.argv[2]})}).then(async r=>{process.stdout.write(JSON.stringify({status:r.status,value:await r.json()}));if(!r.ok)process.exitCode=2})";
  const output = await exec(['docker', 'exec', container, 'node', '-e', request, room, tabId]);
  const result = JSON.parse(String(output).trim());
  if (result.status !== 200) throw new Error(`socket control HTTP ${result.status}`);
  return result.value;
}

function presenceMap(sessions) {
  return Object.fromEntries((sessions ?? []).map((session) => [session.tag, recordsOf(session)]));
}

function matching(records, state, expectedEvent, minimumSeq = -1) {
  return (records ?? []).filter((record) => record?.event === expectedEvent
    && record?.tabId === state.tabId && Number.isSafeInteger(record?.seq) && record.seq > minimumSeq);
}

function eventFrame(state, presence, eventName) {
  const all = Object.values(presence).flat();
  const candidates = matching(all, state, eventName).sort((left, right) => left.seq - right.seq);
  // The member the event acted on: a tab that rejoined leaves again at teardown, as another client.
  if (eventName === 'leave') return candidates.find((record) => !state.clientId || record.clientId === state.clientId) ?? null;
  if (state.kind === 'drop-socket' && state.presence?.seq !== undefined) {
    return candidates.find((record) => record.seq > state.presence.seq) ?? null;
  }
  return candidates.at(-1) ?? null;
}

function receiptFor(records, state, frame) {
  return (records ?? []).find((record) => record?.seq === frame?.seq
    && record?.event === frame?.event && record?.tabId === state.tabId) ?? null;
}

function eventRecord(state, presence) {
  const eventName = state.kind === 'join' ? 'join' : 'leave';
  const frame = eventFrame(state, presence, eventName);
  const targetClientId = state.clientId ?? frame?.clientId ?? null;
  const presenceValue = frame ? { event: frame.event, seq: frame.seq, recvSharedMs: frame.recvSharedMs } : null;
  const receipts = {};
  for (const tag of othersFor(state.condition, state.client)) {
    const receipt = receiptFor(presence[tag], state, frame);
    receipts[tag] = receipt ? { seq: receipt.seq, recvSharedMs: receipt.recvSharedMs, cdpMs: receipt.cdpMs } : null;
  }
  const observed = Boolean(frame) && Object.values(receipts).every(Boolean)
    && Object.values(receipts).every((receipt) => receipt.seq === frame.seq);
  const value = {
    kind: state.kind,
    client: state.client,
    ...(state.kind === 'leave-supplier-silent' ? { victim: state.victim, selection: state.selection } : {}),
    tabId: state.tabId,
    clientId: targetClientId,
    at: state.at,
    issuedAtHarnessMs: state.issuedAtHarnessMs,
    readBack: state.readBack ?? null,
    presence: presenceValue,
    receipts,
    observed,
  };
  if (state.kind === 'drop-socket') {
    const rejoin = eventFrame({ ...state, presence: presenceValue }, presence, 'join');
    value.leave = frame ? { seq: frame.seq, recvSharedMs: frame.recvSharedMs, clientId: frame.clientId } : null;
    value.rejoin = rejoin ? { seq: rejoin.seq, recvSharedMs: rejoin.recvSharedMs, clientId: rejoin.clientId } : null;
  }
  return value;
}

/** Issue one mechanism and retain its exact harness-side read-back. */
export async function issueRosterEvent({ condition, topology, sessions, targetSession, room,
  activateJoin, stopSession, disposeSession, cutNetwork = setInterfaceDown, terminate = terminateSocket,
  client, kind = condition?.rosterEvent?.kind, at = condition?.rosterEvent?.at,
  runDir, selection = null, now = Date.now } = {}) {
  if (!condition || !kind || (!targetSession && kind !== 'leave-supplier-silent')) {
    throw new Error('roster event needs a condition, kind and target session');
  }
  if (kind === 'leave-supplier-silent' && !targetSession) {
    const value = { kind, client: null, victim: null, reason: 'no-active-supplier', selection,
      issuedAtHarnessMs: now(), observed: false };
    if (runDir) writeJson(path.join(runDir, 'roster-event.json'), value);
    return value;
  }
  const state = {
    condition, kind, client: client ?? rosterEventTarget(condition, kind), tabId: targetSession.tag,
    clientId: latestMemberId(targetSession), at, issuedAtHarnessMs: now(), readBack: null,
    ...(kind === 'leave-supplier-silent' ? { victim: client ?? targetSession.tag, selection } : {}),
  };
  if (kind === 'join') {
    if (typeof activateJoin !== 'function') throw new Error('join roster event needs an activation callback');
    state.readBack = await activateJoin(targetSession);
    state.clientId ??= latestMemberId(targetSession);
  } else if (kind === 'leave-clean' || kind === 'leave-first') {
    await stopSession?.(targetSession);
    state.readBack = await (disposeSession ?? targetSession.dispose)?.();
  } else if (kind === 'leave-silent' || kind === 'leave-supplier-silent') {
    state.readBack = await cutNetwork({ topology, tag: targetSession.tag });
  } else if (kind === 'drop-socket') {
    state.readBack = await terminate({ topology, room, tabId: targetSession.tag });
  } else {
    throw new Error(`unsupported roster event kind: ${kind}`);
  }
  if (runDir) writeJson(path.join(runDir, 'roster-event.json'), {
    kind: state.kind, client: state.client, tabId: state.tabId, clientId: state.clientId,
    at: state.at, issuedAtHarnessMs: state.issuedAtHarnessMs, readBack: state.readBack,
    ...(state.kind === 'leave-supplier-silent' ? { victim: state.victim, selection: state.selection } : {}),
    presence: null, receipts: Object.fromEntries(othersFor(condition, state.client).map((tag) => [tag, null])), observed: false,
    ...(state.kind === 'drop-socket' ? { leave: null, rejoin: null } : {}),
  });
  return state;
}

/** Re-read the receipts after all CDP streams have been drained. */
export function finalizeRosterEvent(state, sessions, runDir) {
  if (!state) return null;
  if (state.kind === 'leave-supplier-silent' && state.victim === null) {
    if (runDir) writeJson(path.join(runDir, 'roster-event.json'), state);
    return state;
  }
  const value = eventRecord(state, presenceMap(sessions));
  if (runDir) writeJson(path.join(runDir, 'roster-event.json'), value);
  return value;
}

export { setInterfaceDown, terminateSocket };
