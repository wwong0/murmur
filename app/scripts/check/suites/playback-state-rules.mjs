import { check, assertEqual } from '../harness.mjs';
import { createPlaybackStateHolder } from '../../../public/lib/playback-state.mjs';
import {
  ADDR_ROOM,
  TYPE_PLAYBACK_OPERATION,
  TYPE_PLAYBACK_STATE_ANSWER,
  TYPE_PLAYBACK_STATE_REQUEST,
  buildPlaybackOperationEnvelope,
  buildPlaybackStateAnswerEnvelope,
} from '../../../public/lib/envelope.mjs';

const INITIAL = {
  lineage: 'lineage-a',
  version: 10,
  current: { playing: true, atSharedMs: 50000, mediaMs: 10000 },
  previous: null,
  controlMode: 'open',
};
const HOST = { clientId: 'H', tabId: 'h', role: 'host', joinedAt: 1 };
const VIEWER = { clientId: 'V', tabId: 'v', role: 'viewer', joinedAt: 2 };

function env(seq, from, recv, payload) {
  return { seq, from, ts: { recv }, payload };
}

function create(seq, from, recv, state = INITIAL) {
  return env(seq, from, recv, {
    kind: 'create',
    lineage: state.lineage,
    controlMode: state.controlMode,
    current: state.current,
    previous: state.previous,
  });
}

function operation(seq, from, recv, kind, basis, extra = {}) {
  return env(seq, from, recv, { kind, basis, ...extra });
}

function fresh(state = INITIAL) {
  const h = createPlaybackStateHolder({ maxFutureMs: 10000 });
  h.adopt(state);
  return h;
}

export default async function playbackStateRulesSuite() {
  await check('playback wire: operation and directed answer builders preserve routing and payloads', async () => {
    const operationPayload = { kind: 'pause', basis: { lineage: 'lineage-a', version: 10 }, atSharedMs: 53000 };
    const operationEnvelope = buildPlaybackOperationEnvelope(operationPayload);
    assertEqual(operationEnvelope.type, TYPE_PLAYBACK_OPERATION, 'operation type');
    assertEqual(operationEnvelope.to, ADDR_ROOM, 'operation destination');
    assertEqual(operationEnvelope.payload, operationPayload, 'operation payload is preserved');
    assertEqual(TYPE_PLAYBACK_STATE_REQUEST, 'playback-state-request', 'request type');

    const answerPayload = { state: null, throughSeq: 12 };
    const answerEnvelope = buildPlaybackStateAnswerEnvelope({ to: 'viewer', replyTo: 'request-1', payload: answerPayload });
    assertEqual(answerEnvelope.type, TYPE_PLAYBACK_STATE_ANSWER, 'answer type');
    assertEqual(answerEnvelope.to, 'viewer', 'answer destination');
    assertEqual(answerEnvelope.replyTo, 'request-1', 'answer correlation');
    assertEqual(answerEnvelope.payload, answerPayload, 'answer payload is preserved');
  });

  await check('playback state rules: creation is first-wins and requires an unresolved holder', async () => {
  const h = createPlaybackStateHolder({ maxFutureMs: 10000 });
  h.expectCreation();
  assertEqual(h.awaitingCreation, true, 'holder enters creation mode');
  assertEqual(h.apply(create(11, 'A', 50000), [VIEWER]).outcome, 'applied', 'first creation applies');
  assertEqual(h.awaitingCreation, false, 'creation resolves the holder');
  const identity = JSON.stringify({ lineage: h.state.lineage, version: h.state.version });
  assertEqual(h.apply(create(12, 'B', 50000), [VIEWER]).outcome, 'stale', 'second creation is stale');
  assertEqual(JSON.stringify({ lineage: h.state.lineage, version: h.state.version }), identity, 'second creation cannot replace state');
  assertEqual(h.counters.rejected.stale, 1, 'second creation increments stale count');

  const held = fresh();
  held.expectCreation();
  assertEqual(held.apply(create(11, 'A', 50000), [VIEWER]).outcome, 'stale', 'creation is rejected while a state is held');
  });

  await check('playback state rules: host mode uses the roster at the operation sequence', async () => {
  const state = { ...INITIAL, controlMode: 'host' };
  const basis = { lineage: 'lineage-a', version: 10 };
  const hostAndViewer = [HOST, VIEWER];
  const hostlessViewer = [VIEWER];
  const same = operation(11, 'V', 52000, 'pause', basis, { atSharedMs: 53000 });

  const restricted = fresh(state);
  assertEqual(restricted.apply(same, hostAndViewer).outcome, 'notPermitted', 'viewer pause is rejected while a host is present');
  const released = fresh(state);
  assertEqual(released.apply(same, hostlessViewer).outcome, 'applied', 'viewer pause is accepted when no host remains');
  assertEqual(released.state.current.mediaMs, 13000, 'hostless viewer pause uses the timeline position');

  const absent = fresh(state);
  assertEqual(absent.apply(operation(11, 'missing', 52000, 'pause', basis, { atSharedMs: 53000 }), hostAndViewer).outcome, 'notPermitted', 'absent sender has no host role');
  });

  await check('playback state rules: only a host may change control mode', async () => {
  const basis = { lineage: 'lineage-a', version: 10 };
  const viewer = fresh();
  assertEqual(viewer.apply(operation(11, 'V', 52000, 'control-mode', basis, { controlMode: 'host' }), [HOST, VIEWER]).outcome, 'notPermitted', 'viewer mode change is rejected');
  assertEqual(viewer.state.controlMode, 'open', 'rejected mode change leaves open mode');

  const host = fresh();
  assertEqual(host.apply(operation(11, 'H', 52000, 'control-mode', basis, { controlMode: 'host' }), [HOST, VIEWER]).outcome, 'applied', 'host mode change applies');
  assertEqual(host.state.controlMode, 'host', 'host mode is held');
  });
}
