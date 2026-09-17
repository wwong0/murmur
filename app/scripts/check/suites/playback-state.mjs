import { check, assert, assertEqual } from '../harness.mjs';
import {
  createPlaybackStateHolder,
  epochMsAt,
  mediaMsAt,
  readPlaybackState,
  stateIdentity,
} from '../../../public/lib/playback-state.mjs';

const BASE = {
  lineage: 'lineage-a',
  version: 10,
  current: { playing: true, atSharedMs: 50000, mediaMs: 10000 },
  previous: null,
  controlMode: 'open',
};
const ROSTER = [
  { clientId: 'A', tabId: 'a', role: 'viewer', joinedAt: 1 },
  { clientId: 'B', tabId: 'b', role: 'viewer', joinedAt: 2 },
  { clientId: 'C', tabId: 'c', role: 'viewer', joinedAt: 3 },
];

function env(seq, from, recv, payload) {
  return { seq, from, ts: { recv }, payload };
}

function operation(seq, from, recv, kind, basis, extra = {}) {
  return env(seq, from, recv, { kind, basis, ...extra });
}

function create(seq, from, recv, state = BASE) {
  return env(seq, from, recv, {
    kind: 'create',
    lineage: state.lineage,
    controlMode: state.controlMode,
    current: state.current,
    previous: state.previous,
  });
}

function holder(state = BASE, maxFutureMs = 10000) {
  const h = createPlaybackStateHolder({ maxFutureMs });
  h.adopt(state);
  return h;
}

function assertOutcome(actual, expected, label) {
  assertEqual(actual.outcome, expected, label);
}

export default async function playbackStateSuite() {
  await check('playback state: three holders fold one interleaved stream identically after every envelope', async () => {
  const holders = [holder(), holder(), holder()];
  const stream = [
    operation(11, 'A', 52000, 'pause', { lineage: 'lineage-a', version: 10 }, { atSharedMs: 53000 }),
    operation(12, 'B', 54000, 'play', { lineage: 'lineage-a', version: 11 }, { atSharedMs: 55000 }),
    operation(13, 'C', 56000, 'seek', { lineage: 'lineage-a', version: 12 }, { atSharedMs: 57000, positionMs: 16000 }),
  ];

  for (const [index, message] of stream.entries()) {
    for (const h of holders) assertOutcome(h.apply(message, ROSTER), 'applied', `stream ${index} applies`);
    const serialized = JSON.stringify(holders[0].state);
    for (const h of holders.slice(1)) assertEqual(JSON.stringify(h.state), serialized, `holder agrees after stream ${index}`);
  }
  assertEqual(JSON.stringify(stateIdentity(holders[0].state)), JSON.stringify({ lineage: 'lineage-a', version: 13 }), 'identity follows seq');
  });

  await check('playback state: issuing without delivery does not change the state', async () => {
  const h = holder();
  const before = JSON.stringify(h.state);
  const identity = JSON.stringify(stateIdentity(h.state));
  const payload = { kind: 'pause', basis: { lineage: 'lineage-a', version: 10 }, atSharedMs: 53000 };
  assert(payload && payload.kind === 'pause', 'an operation payload can be constructed without applying it');
  assertEqual(JSON.stringify(h.state), before, 'state is unchanged before server delivery');
  assertEqual(JSON.stringify(stateIdentity(h.state)), identity, 'identity is unchanged before server delivery');
  });

  await check('playback state: compare-and-set rejects concurrent actions with ordered counts', async () => {
  const h = holder();
  const basis = { lineage: 'lineage-a', version: 10 };
  assertOutcome(h.apply(operation(11, 'A', 52000, 'pause', basis, { atSharedMs: 53000 }), ROSTER), 'applied', 'first pause applies');
  assertOutcome(h.apply(operation(12, 'B', 52000, 'pause', basis, { atSharedMs: 53000 }), ROSTER), 'stale', 'second pause is stale');
  assertEqual(h.counters.rejected.stale, 1, 'stale pause count');
  assertEqual(h.state.version, 11, 'stale pause does not advance version');

  const race = holder();
  assertOutcome(race.apply(operation(11, 'A', 52000, 'pause', basis, { atSharedMs: 53000 }), ROSTER), 'applied', 'pause wins its race');
  assertOutcome(race.apply(operation(12, 'B', 52000, 'seek', basis, { atSharedMs: 53000, positionMs: 20000 }), ROSTER), 'stale', 'seek loses its race');
  assertEqual(race.state.current.mediaMs, 13000, 'the pause position remains authoritative');
  assertEqual(race.counters.rejected.stale, 1, 'racing seek count');
  });

  await check('playback state: malformed, stale, permission and applicability reasons are counted in order', async () => {
  const malformedCases = [
    operation(11, 'A', 52000, 'pause', { lineage: 'lineage-a', version: 10 }, { atSharedMs: NaN }),
    operation(12, 'A', 52000, 'pause', { lineage: 'lineage-a', version: 10 }, { atSharedMs: Infinity }),
    operation(13, 'A', 52000, 'pause', { lineage: 'lineage-a', version: 10 }, { atSharedMs: '53000' }),
    operation(14, 'A', 52000, 'seek', { lineage: 'lineage-a', version: 10 }, { atSharedMs: 53000, positionMs: NaN }),
    operation(15, 'A', Infinity, 'pause', { lineage: 'lineage-a', version: 10 }, { atSharedMs: 53000 }),
  ];
  const h = holder();
  const before = JSON.stringify(h.state);
  for (const [index, message] of malformedCases.entries()) {
    assertOutcome(h.apply(message, ROSTER), 'malformed', `non-finite case ${index}`);
    assertEqual(JSON.stringify(h.state), before, `malformed case ${index} leaves state unchanged`);
  }
  assertEqual(h.counters.rejected.malformed, malformedCases.length, 'malformed count');

  const order = holder({ ...BASE, controlMode: 'host' });
  const basis = { lineage: 'lineage-a', version: 10 };
  assertOutcome(order.apply(operation(11, 'B', 52000, 'pause', { lineage: 'lineage-a', version: 10 }, { atSharedMs: NaN }), ROSTER), 'malformed', 'malformed precedes stale');
  assertOutcome(order.apply(operation(12, 'B', 52000, 'pause', { lineage: 'wrong', version: 9 }, { atSharedMs: 53000 }), [{ clientId: 'H', role: 'host' }, { clientId: 'B', role: 'viewer' }]), 'stale', 'stale precedes permission');
  assertOutcome(order.apply(operation(13, 'B', 52000, 'play', basis, { atSharedMs: 53000 }), [{ clientId: 'H', role: 'host' }, { clientId: 'B', role: 'viewer' }]), 'notPermitted', 'permission precedes applicability');
  assertEqual(order.counters.rejected.malformed, 1, 'ordered malformed count');
  assertEqual(order.counters.rejected.stale, 1, 'ordered stale count');
  assertEqual(order.counters.rejected.notPermitted, 1, 'ordered permission count');

  const notApplicable = holder();
  assertOutcome(notApplicable.apply(operation(11, 'A', 52000, 'play', basis, { atSharedMs: 53000 }), ROSTER), 'notApplicable', 'play against playing is not applicable');
  assertEqual(notApplicable.state.version, 10, 'not-applicable play does not advance version');
  });

  await check('playback state: effective instants retain the past and map both sides', async () => {
  const h = holder();
  assertOutcome(h.apply(operation(11, 'A', 52000, 'pause', { lineage: 'lineage-a', version: 10 }, { atSharedMs: 53000 }), ROSTER), 'applied', 'pause applies');
  assertEqual(h.state.current.playing, false, 'pause makes current mapping paused');
  assertEqual(h.state.current.atSharedMs, 53000, 'pause uses requested effective instant');
  assertEqual(h.state.current.mediaMs, 13000, 'pause computes position from the prior mapping');
  assertEqual(mediaMsAt(h.state, 52000), 12000, 'past instant uses previous mapping');
  assertEqual(mediaMsAt(h.state, 54000), 13000, 'future instant uses current mapping');
  assertEqual(epochMsAt(h.state, 52000), 40000, 'past epoch comes from playing predecessor');
  assertEqual(epochMsAt(h.state, 54000), null, 'paused mapping has no epoch');
  assertEqual(mediaMsAt(h.state, 49000), null, 'instant before retained mappings has no position');
  assertEqual(mediaMsAt(null, 52000), null, 'missing state has no position');
  assertEqual(mediaMsAt(h.state, NaN), null, 'non-finite instant has no position');

  const pending = holder();
  assertOutcome(pending.apply(operation(11, 'A', 52000, 'pause', { lineage: 'lineage-a', version: 10 }, { atSharedMs: 53000 }), ROSTER), 'applied', 'pending pause applies');
  assertOutcome(pending.apply(operation(12, 'A', 52500, 'play', { lineage: 'lineage-a', version: 11 }, { atSharedMs: 54000 }), ROSTER), 'notApplicable', 'second transition received before first instant is rejected');
  assertEqual(pending.state.version, 11, 'pending rejection preserves version');

  const earlier = holder();
  assertOutcome(earlier.apply(operation(11, 'A', 51000, 'pause', { lineage: 'lineage-a', version: 10 }, { atSharedMs: 49000 }), ROSTER), 'applied', 'earlier requested instant applies');
  assertEqual(earlier.state.current.atSharedMs, 50000, 'effective instant never moves backwards');
  assertEqual(earlier.state.current.mediaMs, 10000, 'earlier request uses current position');
  });

  await check('playback state: measurement mappings, control-mode-only changes and seek clamp are exact', async () => {
  const playing = readPlaybackState({
    lineage: 'measure', version: 1,
    current: { playing: true, atSharedMs: 5000, mediaMs: 7000 }, previous: null, controlMode: 'open',
  });
  assert(playing && Object.is(Object.getPrototypeOf(playing), Object.prototype), 'valid state is readable');
  assertEqual(mediaMsAt(playing, 12000), 14000, 'playing measurement position');
  assertEqual(epochMsAt(playing, 12000), -2000, 'playing measurement epoch');
  const paused = readPlaybackState({
    lineage: 'measure', version: 2,
    current: { playing: false, atSharedMs: 5000, mediaMs: 7000 }, previous: null, controlMode: 'open',
  });
  assertEqual(mediaMsAt(paused, 12000), 7000, 'paused measurement position');
  assertEqual(epochMsAt(paused, 12000), null, 'paused measurement epoch');

  const h = holder();
  const oldMappings = JSON.stringify({ current: h.state.current, previous: h.state.previous });
  assertOutcome(h.apply(env(11, 'H', 52000, { kind: 'control-mode', basis: { lineage: 'lineage-a', version: 10 }, controlMode: 'host' }), [{ clientId: 'H', role: 'host' }]), 'applied', 'host changes mode');
  assertEqual(h.state.controlMode, 'host', 'new mode is held');
  assertEqual(JSON.stringify({ current: h.state.current, previous: h.state.previous }), oldMappings, 'mode change keeps both mappings');

  const seek = holder();
  assertOutcome(seek.apply(operation(11, 'A', 52000, 'seek', { lineage: 'lineage-a', version: 10 }, { atSharedMs: 53000, positionMs: -4000 }), ROSTER), 'applied', 'negative seek applies');
  assert(Object.is(seek.state.current.mediaMs, 0), 'negative seek clamps to exactly positive zero');
  });

  await check('playback state: far-future bound accepts equality, rejects one millisecond beyond and leaves no pending slot', async () => {
  const zero = {
    lineage: 'lineage-a', version: 1,
    current: { playing: true, atSharedMs: 0, mediaMs: 0 }, previous: null, controlMode: 'open',
  };
  const basis = { lineage: 'lineage-a', version: 1 };
  const exact = holder(zero, 777);
  assertOutcome(exact.apply(operation(2, 'A', 1000, 'pause', basis, { atSharedMs: 1777 }), ROSTER), 'applied', 'operation at bound is accepted');

  const beyond = holder(zero, 777);
  const before = JSON.stringify(beyond.state);
  assertOutcome(beyond.apply(operation(2, 'A', 1000, 'pause', basis, { atSharedMs: 1778 }), ROSTER), 'malformed', 'operation one millisecond beyond bound is malformed');
  assertEqual(JSON.stringify(beyond.state), before, 'far-future operation leaves state unchanged');
  assertOutcome(beyond.apply(operation(3, 'A', 1000, 'pause', basis, { atSharedMs: 1500 }), ROSTER), 'applied', 'valid pause applies after rejected future operation');

  const currentExact = createPlaybackStateHolder({ maxFutureMs: 777 });
  currentExact.expectCreation();
  assertOutcome(currentExact.apply(create(2, 'A', 1000, {
    ...zero, current: { playing: true, atSharedMs: 1777, mediaMs: 0 },
  }), ROSTER), 'applied', 'creation current at bound is accepted');

  const currentBeyond = createPlaybackStateHolder({ maxFutureMs: 777 });
  currentBeyond.expectCreation();
  assertOutcome(currentBeyond.apply(create(2, 'A', 1000, {
    ...zero, current: { playing: true, atSharedMs: 1778, mediaMs: 0 },
  }), ROSTER), 'malformed', 'creation current one millisecond beyond bound is malformed');
  assertEqual(currentBeyond.state, null, 'bad creation does not establish state');

  const previousExact = createPlaybackStateHolder({ maxFutureMs: 777 });
  previousExact.expectCreation();
  assertOutcome(previousExact.apply(create(2, 'A', 1000, {
    ...zero,
    current: { playing: true, atSharedMs: 1777, mediaMs: 0 },
    previous: { playing: true, atSharedMs: 1777, mediaMs: 0 },
  }), ROSTER), 'applied', 'creation previous at bound is accepted');

  const previousBeyond = createPlaybackStateHolder({ maxFutureMs: 777 });
  previousBeyond.expectCreation();
  assertOutcome(previousBeyond.apply(create(2, 'A', 1000, {
    ...zero,
    current: { playing: true, atSharedMs: 1778, mediaMs: 0 },
    previous: { playing: true, atSharedMs: 1778, mediaMs: 0 },
  }), ROSTER), 'malformed', 'creation previous one millisecond beyond bound is malformed');
  assertEqual(previousBeyond.state, null, 'bad previous mapping does not establish state');
  });
}
