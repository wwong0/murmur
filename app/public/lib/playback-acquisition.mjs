import {
  TYPE_PLAYBACK_OPERATION,
  TYPE_PLAYBACK_STATE_REQUEST,
  TYPE_PLAYBACK_STATE_ANSWER,
  TYPE_PRESENCE,
  ADDR_SERVER,
  buildPlaybackOperationEnvelope,
  buildPlaybackStateAnswerEnvelope,
  readBody,
} from './envelope.mjs';
import {
  createPlaybackStateHolder,
  readPlaybackState,
  stateIdentity,
} from './playback-state.mjs';
import { electCreator } from './state-election.mjs';

export const ACQUISITION_REQUEST_TIMEOUT_MS = 1000;
export const ACQUISITION_BACKOFF_MS = 500;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function createPlaybackAcquisition({
  client,
  clock,
  settings = {},
  mintLineage,
  store,
  room,
  onOutcome = () => {},
  report = () => {},
}) {
  const transitionLeadMs = settings.transitionLeadMs ?? 0;
  const maxFutureMs = settings.maxFutureMs ?? 0;
  const requestTimeoutMs = settings.requestTimeoutMs ?? ACQUISITION_REQUEST_TIMEOUT_MS;
  const backoffMs = settings.backoffMs ?? ACQUISITION_BACKOFF_MS;
  // T5 (design.md D3/D4): whether the room has peer exchange, read at creation
  // and at issue — not cached, since T10's single derivation may not have
  // settled the first time `poll()` runs.
  const holds = settings.holds ?? (() => false);
  const autoStart = settings.autoStart ?? (() => false);
  if (![transitionLeadMs, maxFutureMs, requestTimeoutMs, backoffMs].every(validNumber)
    || transitionLeadMs < 0 || maxFutureMs < 0 || requestTimeoutMs < 0 || backoffMs < 0) {
    throw new TypeError('acquisition settings must be finite non-negative numbers');
  }
  if (!client || !clock || typeof clock.sharedNow !== 'function' || typeof mintLineage !== 'function') {
    throw new TypeError('acquisition needs a client, clock and lineage function');
  }

  const holder = createPlaybackStateHolder({ maxFutureMs });
  let disposed = false;
  let generation = 0;
  let roster = [];
  let joinedSeq = null;
  let lastFoldedSeq = null;
  let proposal = null;
  let buffer = [];
  let creationEligible = false;
  let creationIssued = false;
  let requestToken = 0;
  let activePass = null;
  let activeRequest = null;
  let passTimer = null;
  let passTargets = [];
  let passIndex = 0;
  let adopted = 0;
  let created = 0;
  let requests = 0;
  let malformedAnswers = 0;
  let abandoned = 0;
  let subscriberErrors = 0;
  let bufferedOperations = 0;
  const unsubs = [];
  // The entry enters a room in-page after construction (hostRoom), so the
  // room's name is read at each use, not captured here.
  const roomName = () => (typeof room === 'function' ? room() : room);

  function reportFailure(where, error) {
    try {
      report(where, error);
    } catch {
      // Reporting is diagnostic and must not become a subscriber failure.
    }
  }

  function persistState() {
    const name = roomName();
    if (!store || typeof name !== 'string') return;
    try {
      store.set(JSON.stringify({ room: name, state: holder.state }));
    } catch (error) {
      reportFailure('store', error);
    }
  }

  function loadProposal() {
    const name = roomName();
    if (!store || typeof name !== 'string') return;
    try {
      const raw = store.get();
      if (raw === null) return;
      const entry = JSON.parse(raw);
      if (!object(entry) || Object.keys(entry).length !== 2 || !('room' in entry) || !('state' in entry) || entry.room !== name) return;
      const state = readPlaybackState(entry.state);
      if (state) proposal = state;
    } catch (error) {
      reportFailure('store', error);
    }
  }

  loadProposal();

  function safe(where, fn) {
    try {
      fn();
    } catch (error) {
      subscriberErrors += 1;
      reportFailure(where, error);
    }
  }

  function outcome(env, value) {
    try {
      onOutcome({ env, outcome: value });
    } catch (error) {
      subscriberErrors += 1;
      reportFailure('onOutcome', error);
    }
  }

  function timer(fn, delay) {
    const handle = setTimeout(fn, delay);
    if (typeof handle === 'object' && handle.unref) handle.unref();
    return handle;
  }

  function clearWork() {
    requestToken += 1;
    activePass = null;
    activeRequest = null;
    if (passTimer !== null) clearTimeout(passTimer);
    passTimer = null;
  }

  function currentGeneration(token) {
    return !disposed && token === generation;
  }

  function hasMember(clientId) {
    return roster.some((member) => member && member.clientId === clientId);
  }

  function soleMember() {
    const self = client.clientId;
    return typeof self === 'string' && roster.length === 1 && roster[0]?.clientId === self;
  }

  function applyPresence(env) {
    const body = readBody(env);
    if (object(body) && Array.isArray(body.roster)) roster = body.roster;
    if (Number.isInteger(env.seq)) lastFoldedSeq = Math.max(lastFoldedSeq ?? env.seq, env.seq);
  }

  function applyOperation(env) {
    const result = holder.apply(env, roster);
    outcome(env, result.outcome);
    if (result.outcome === 'applied') {
      if (env.payload?.kind === 'create' && env.from === client.clientId) created += 1;
      proposal = holder.state;
      persistState();
    }
    if (Number.isInteger(env.seq)) lastFoldedSeq = Math.max(lastFoldedSeq ?? env.seq, env.seq);
    return result;
  }

  function foldForCreation() {
    const entries = buffer;
    buffer = [];
    for (const env of entries) {
      if (env.type === TYPE_PRESENCE) applyPresence(env);
      else applyOperation(env);
    }
  }

  function tryCreation() {
    if (!currentGeneration(generation) || !creationEligible || creationIssued
      || holder.state || !holder.awaitingCreation) return;
    let current;
    if (proposal) {
      // T5: a rejoin's proposal carries its mappings, `held` included — a room
      // that was held stays held across the sole member's own reconnect.
      current = {
        playing: proposal.current.playing,
        atSharedMs: proposal.current.atSharedMs,
        mediaMs: proposal.current.mediaMs,
        ...(proposal.current.held === true ? { held: true } : {}),
      };
    } else {
      const now = clock.sharedNow();
      if (!validNumber(now)) return;
      current = autoStart()
        ? holds()
          ? { playing: false, atSharedMs: now + transitionLeadMs, mediaMs: 0, held: true }
          : { playing: true, atSharedMs: now + transitionLeadMs, mediaMs: 0 }
        : { playing: false, atSharedMs: now + transitionLeadMs, mediaMs: 0 };
    }
    creationIssued = true;
    const payload = {
      kind: 'create',
      lineage: mintLineage(),
      current,
      previous: proposal?.previous ?? null,
      controlMode: proposal?.controlMode ?? 'open',
      ...(proposal?.title === undefined ? {} : { title: proposal.title }),
    };
    try {
      client.send(buildPlaybackOperationEnvelope(payload));
    } catch (error) {
      reportFailure('creation', error);
    }
  }

  function foldAfterAdoption(throughSeq) {
    const entries = buffer;
    buffer = [];
    let high = throughSeq;
    for (const env of entries) {
      if (Number.isInteger(env.seq)) high = Math.max(high, env.seq);
      if (env.type === TYPE_PRESENCE) applyPresence(env);
      else if (env.seq > throughSeq) applyOperation(env);
    }
    lastFoldedSeq = high;
  }

  function becomeSole() {
    if (!soleMember()) return;
    creationEligible = true;
    clearWork();
    if (!holder.state) {
      if (!holder.awaitingCreation) holder.expectCreation();
      foldForCreation();
    }
    tryCreation();
  }

  function currentOtherMembers() {
    return [...new Set(roster
      .map((member) => member?.clientId)
      .filter((clientId) => typeof clientId === 'string' && clientId !== client.clientId))];
  }

  function electFrom(pass) {
    const members = currentOtherMembers();
    if (!members.length || !members.every((clientId) => pass.answers.get(clientId)?.state === null)) {
      return false;
    }
    const winner = electCreator({
      selfId: client.clientId,
      selfHeldVersion: Number.isInteger(proposal?.version) ? proposal.version : null,
      answers: members.map((clientId) => ({ clientId, heldVersion: pass.answers.get(clientId).heldVersion })),
    });
    if (winner !== client.clientId) return false;
    creationEligible = true;
    if (!holder.awaitingCreation) holder.expectCreation();
    tryCreation();
    return true;
  }

  function validAnswer(body) {
    if (!object(body) || !('state' in body)) return null;
    if (body.state === null) {
      if (!('heldVersion' in body)
        || !(body.heldVersion === null || Number.isInteger(body.heldVersion))) return null;
      return { state: null, heldVersion: body.heldVersion };
    }
    const state = readPlaybackState(body.state);
    if (!state || !Number.isInteger(body.throughSeq)
      || body.throughSeq <= joinedSeq || body.throughSeq < state.version) return null;
    return { state, throughSeq: body.throughSeq };
  }

  function finishPass(pass) {
    if (activePass !== pass || !currentGeneration(pass.generation)) return;
    activePass = null;
    if (electFrom(pass)) return;
    passTimer = timer(() => {
      passTimer = null;
      if (!holder.state) beginPass();
    }, backoffMs);
  }

  function advance(pass) {
    if (activePass !== pass || !currentGeneration(pass.generation)
      || holder.state) return;
    while (passIndex < passTargets.length) {
      const target = passTargets[passIndex++];
      if (!hasMember(target)) continue;
      const request = { generation: pass.generation, token: pass.token, target };
      activeRequest = request;
      requests += 1;
      let pending;
      try {
        pending = client.request({
          type: TYPE_PLAYBACK_STATE_REQUEST,
          to: target,
          payload: {},
          timeoutMs: requestTimeoutMs,
        });
      } catch (error) {
        pending = Promise.reject(error);
      }
      Promise.resolve(pending).then(
        (env) => safe('state-request', () => settleRequest(request, env)),
        () => safe('state-request', () => settleRequest(request, null)),
      );
      return;
    }
    finishPass(pass);
  }

  function settleRequest(request, env) {
    if (activeRequest !== request || activePass?.token !== request.token
      || !currentGeneration(request.generation)) return;
    activeRequest = null;
    if (!env) {
      advance(activePass);
      return;
    }
    const answer = validAnswer(readBody(env));
    if (!answer) {
      malformedAnswers += 1;
      advance(activePass);
      return;
    }
    if (answer.state === null) {
      activePass.answers.set(request.target, answer);
      advance(activePass);
      return;
    }
    holder.adopt(answer.state);
    proposal = holder.state;
    persistState();
    adopted += 1;
    activePass = null;
    if (passTimer !== null) clearTimeout(passTimer);
    passTimer = null;
    lastFoldedSeq = answer.throughSeq;
    foldAfterAdoption(answer.throughSeq);
  }

  function beginPass() {
    if (disposed || holder.state || creationIssued || creationEligible || activePass || passTimer) return;
    if (!holder.awaitingCreation) holder.expectCreation();
    const pass = { generation, token: ++requestToken, answers: new Map() };
    activePass = pass;
    passTargets = roster
      .map((member) => member?.clientId)
      .filter((clientId) => typeof clientId === 'string' && clientId !== client.clientId);
    passIndex = 0;
    advance(pass);
  }

  function handleJoined(joined) {
    generation += 1;
    clearWork();
    proposal = holder.state ?? proposal;
    holder.reset();
    roster = Array.isArray(joined?.roster) ? joined.roster : [];
    joinedSeq = Number.isInteger(joined?.seq) ? joined.seq : 0;
    lastFoldedSeq = joinedSeq;
    buffer = [];
    creationEligible = false;
    creationIssued = false;
    if (!holder.state) holder.expectCreation();
    if (soleMember()) {
      creationEligible = true;
      tryCreation();
    } else {
      beginPass();
    }
  }

  function handlePresence(env) {
    if (env.from !== ADDR_SERVER || disposed) return;
    const body = readBody(env);
    const nextRoster = object(body) && Array.isArray(body.roster) ? body.roster : roster;
    if (!holder.state) {
      roster = nextRoster;
      // Presence joins the same ordered buffer as operations but is not counted
      // by `bufferedOperations`, which reports operations only.
      buffer.push(env);
      if (activeRequest && !hasMember(activeRequest.target)) {
        abandoned += 1;
        activeRequest = null;
        requestToken += 1;
        advance(activePass);
      }
      if (soleMember()) becomeSole();
      else beginPass();
      return;
    }
    applyPresence(env);
  }

  function handleOperation(env) {
    if (disposed) return;
    if (!holder.state) {
      buffer.push(env);
      if (env.type === TYPE_PLAYBACK_OPERATION) bufferedOperations += 1;
      if (env.payload?.kind === 'create') {
        if (!holder.awaitingCreation) holder.expectCreation();
        foldForCreation();
      }
      return;
    }
    applyOperation(env);
  }

  function handleRequest(env) {
    const state = holder.state;
    const payload = state
      ? { state, throughSeq: lastFoldedSeq }
      : {
        state: null,
        heldVersion: Number.isInteger(proposal?.version) ? proposal.version : null,
      };
    try {
      client.send(buildPlaybackStateAnswerEnvelope({
        to: env.from,
        replyTo: env.id,
        payload,
      }));
    } catch (error) {
      reportFailure('state-answer', error);
    }
  }

  function safeJoined(value) { safe('joined', () => handleJoined(value)); }
  function safePresence(value) { safe(TYPE_PRESENCE, () => handlePresence(value)); }
  function safeOperation(value) { safe(TYPE_PLAYBACK_OPERATION, () => handleOperation(value)); }
  function safeRequest(value) { safe(TYPE_PLAYBACK_STATE_REQUEST, () => handleRequest(value)); }
  unsubs.push(client.onEvent('joined', safeJoined));
  unsubs.push(client.on(TYPE_PRESENCE, safePresence));
  unsubs.push(client.on(TYPE_PLAYBACK_OPERATION, safeOperation));
  unsubs.push(client.on(TYPE_PLAYBACK_STATE_REQUEST, safeRequest));

  function issue(kind, args = {}) {
    if (disposed || !holder.state) return false;
    const now = clock.sharedNow();
    if (!validNumber(now) || now < holder.state.current.atSharedMs) return false;
    const basis = { lineage: holder.state.lineage, version: holder.state.version };
    let payload = { kind, basis };
    if (kind === 'play' || kind === 'pause') {
      const atSharedMs = kind === 'pause' && validNumber(args.atSharedMs)
        ? args.atSharedMs
        : now + transitionLeadMs;
      payload = { ...payload, atSharedMs };
    } else if (kind === 'seek') {
      payload = {
        ...payload,
        atSharedMs: now + transitionLeadMs,
        positionMs: args.positionMs,
        // D14: a playing or held room with peer exchange holds at the landing; a
        // paused, unheld one must not, or a seek while paused would start it.
        ...(holds() && (holder.state.current.playing || holder.state.current.held === true) ? { hold: true } : {}),
      };
    } else if (kind === 'title') {
      payload = { ...payload, atSharedMs: now + transitionLeadMs, title: args.title };
    } else if (kind === 'control-mode') {
      payload = { ...payload, controlMode: args.controlMode };
    } else {
      return false;
    }
    try {
      client.send(buildPlaybackOperationEnvelope(payload));
      return true;
    } catch (error) {
      reportFailure('issue', error);
      return false;
    }
  }

  function permitted(kind) {
    if (disposed || !holder.state) return false;
    if (kind === 'control-mode') return client.role === 'host';
    if (kind === 'title') return client.role === 'host';
    if (kind !== 'play' && kind !== 'pause' && kind !== 'seek') return false;
    if (holder.state.controlMode !== 'host') return true;
    return !roster.some((member) => member?.role === 'host') || client.role === 'host';
  }

  return {
    poll() {
      if (disposed) return;
      if (!holder.state) {
        tryCreation();
        if (soleMember()) becomeSole();
        else beginPass();
      }
    },
    issue,
    permitted,
    get state() { return holder.state; },
    get snapshot() {
      const state = holder.state;
      return Object.freeze({
        resolved: state !== null,
        identity: stateIdentity(state),
        playing: state?.current.playing ?? null,
        // T5: `held` is `true`/`false` with a state, `null` without one — the
        // three-value shape `docs/constraints/measurement.md` requires for "no
        // value" against a real false.
        held: state ? state.current.held === true : null,
        controlMode: state?.controlMode ?? null,
        rejected: holder.counters.rejected,
        adopted,
        created,
        requests,
        malformedAnswers,
        abandoned,
        subscriberErrors,
        bufferedOperations,
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      clearWork();
      for (const off of unsubs.splice(0)) {
        try { off(); } catch { /* teardown is best effort */ }
      }
    },
  };
}
