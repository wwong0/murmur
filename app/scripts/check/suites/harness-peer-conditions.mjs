import { assert, assertEqual, check } from '../harness.mjs';
import { evaluateByteControl } from '../../harness/byte-control.mjs';
import { armFor, REFUSAL_SCOPE } from '../../harness/arms.mjs';
import { evaluateRefusals } from '../../harness/refusals.mjs';
import { conditionForName, conditions } from '../../harness-run.mjs';
import { ENGINE_WINDOW_DEFAULTS } from '../../../public/lib/engine-windows.mjs';

const peer = conditions['p2p-naive'];
const peerReasonNames = new Set([
  'peer-exchange-inactive', 'peer-attribution-unavailable', 'peer-log-discarded-records',
  'peer-log-reset', 'peer-anomaly-records', 'position-offset-mismatch', 'build-mismatch',
]);

function loadCandidate(value) {
  return conditionForName('constructed-peer', { 'constructed-peer': value });
}

function refusal(value) {
  const reasons = [];
  armFor(peer).refusals(value, (reason, scope, detail) => reasons.push({ reason, scope, detail }));
  return reasons.filter((entry) => peerReasonNames.has(entry.reason));
}

function validEvidence(overrides = {}) {
  const tags = ['c01', 'c02', 'c03', 'c04', 'c05'];
  const peerReadings = Object.fromEntries(tags.map((tag, index) => [tag, {
    buildId: 'build-a', peerExchange: 'on', positionOffset: { ms: 0, error: null },
    attribution: 'engine-request', peerId: `peer-${index}`,
  }]));
  const peerLogHealth = Object.fromEntries(tags.map((tag) => [tag, { missed: 0, reset: false }]));
  const peerRecords = Object.fromEntries(tags.map((tag) => [tag, []]));
  return {
    condition: peer,
    declaredClientTags: ['c01', 'c02'],
    peerReadings,
    peerLogHealth,
    peerRecords,
    roomFinal: { byClient: {}, unattributedMediaBytesDelivered: 0 },
    linkSamples: [{ atMs: 0, txBytes: 0 }, { atMs: 100, txBytes: 0 }],
    window: { startMs: 0, endMs: 100 },
    originStart: { mediaBytesDelivered: 0 },
    originEnd: { mediaBytesDelivered: 0 },
    ...overrides,
  };
}

function assertTopLevelEqualExcept(left, right, excluded, label) {
  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((field) => !excluded.includes(field));
  for (const field of fields) assertEqual(JSON.stringify(left[field]), JSON.stringify(right[field]), `${label} keeps ${field}`);
}

function assertPeerReason(input, reason, twin, label) {
  const found = refusal(input).find((entry) => entry.reason === reason);
  assert(found, `${label} fires`);
  assertEqual(JSON.stringify(found.scope), JSON.stringify(REFUSAL_SCOPE[{
    'peer-exchange-inactive': 'peerExchange',
    'peer-attribution-unavailable': 'peerAttribution',
    'peer-log-discarded-records': 'peerLog',
    'peer-log-reset': 'peerLog',
    'peer-anomaly-records': 'peerAnomaly',
    'position-offset-mismatch': 'positionOffset',
    'build-mismatch': 'build',
  }[reason]]), `${label} scope`);
  assertEqual(refusal(twin).some((entry) => entry.reason === reason), false, `${label} twin stays silent`);
}

export default async function harnessPeerConditionsSuite() {
  await check('harness peer conditions: three load refusals have one-field loading twins', async () => {
    const base = structuredClone(peer);
    const invalidDelivery = { ...structuredClone(base), delivery: 'http' };
    const deliveryTwin = { ...structuredClone(invalidDelivery), delivery: 'host' };
    let deliveryError = null;
    try { loadCandidate(invalidDelivery); } catch (error) { deliveryError = error; }
    assert(deliveryError?.message.includes('peer-exchange-requires-host-delivery'), 'peer exchange requires host delivery');
    loadCandidate(deliveryTwin);
    assertTopLevelEqualExcept(invalidDelivery, deliveryTwin, ['delivery'], 'delivery twin');

    const invalidBar = structuredClone(base);
    invalidBar.bars.peerFractionAbsMax = 0.02;
    const barTwin = structuredClone(base);
    let barError = null;
    try { loadCandidate(invalidBar); } catch (error) { barError = error; }
    assert(barError?.message.includes('peer-condition-declares-peer-fraction-bar'), 'peer fraction bar is refused');
    loadCandidate(barTwin);
    assertTopLevelEqualExcept(invalidBar, barTwin, ['bars'], 'peer bar twin');
    for (const field of ['recordCoverageMin', 'droppedFrameFractionMax', 'driftLogMissedMax', 'responseCutShortMaxBytes', 'conservationChannelBytes', 'conservationRelativeMax', 'conservationDeliveryGapMs']) {
      assertEqual(invalidBar.bars[field], barTwin.bars[field], `peer bar twin keeps bars.${field}`);
    }
    assertEqual(invalidBar.bars.peerFractionAbsMax, 0.02, 'peer bar twin changes only peerFractionAbsMax');

    const invalidOffset = structuredClone(base);
    invalidOffset.positionOffsetMsByClient.c02 = 600001;
    const offsetTwin = structuredClone(base);
    offsetTwin.positionOffsetMsByClient.c02 = 600000;
    let offsetError = null;
    try { loadCandidate(invalidOffset); } catch (error) { offsetError = error; }
    assert(offsetError?.message.includes('position-offset-invalid'), 'invalid offset is refused');
    loadCandidate(offsetTwin);
    assertTopLevelEqualExcept(invalidOffset, offsetTwin, ['positionOffsetMsByClient'], 'offset twin');
    for (const tag of ['c01', 'c03', 'c04', 'c05']) assertEqual(invalidOffset.positionOffsetMsByClient[tag], offsetTwin.positionOffsetMsByClient[tag], `offset twin keeps ${tag}`);
    assertEqual(invalidOffset.positionOffsetMsByClient.c02, 600001, 'offset twin changes only c02');
  });

  await check('harness peer conditions: copied peer bars cannot bring back the peer fraction control', async () => {
    const copied = structuredClone(peer);
    copied.bars = structuredClone(conditions['hostorigin-nop2p'].bars);
    let thrown = null;
    try { loadCandidate(copied); } catch (error) { thrown = error; }
    assert(thrown?.message.includes('peer-condition-declares-peer-fraction-bar'), 'T4 peer-fraction refusal blocks copied bars at condition load');
  });

  await check('harness peer conditions: peer sources enumerate every unchanged field', async () => {
    const source = conditions['hostorigin-nop2p'];
    const excluded = ['name', 'bars', 'peerExchange', 'positionOffsetMsByClient', 'figureKinds', 'feeds', 'engineWindows'];
    for (const name of ['p2p-naive', 'p2p-scattered']) assertTopLevelEqualExcept(source, conditions[name], excluded, `${name} source`);
    assertEqual(JSON.stringify(Object.keys(peer.bars).sort()), JSON.stringify([
      'conservationChannelBytes', 'conservationRelativeMax', 'driftLogMissedMax',
      'droppedFrameFractionMax', 'recordCoverageMin', 'responseCutShortMaxBytes', 'conservationDeliveryGapMs',
    ].sort()), 'p2p-naive has exactly D4 bars');
    const { controlFloorMin, responseSettleGapMs, ...scatteredBars } = conditions['p2p-scattered'].bars;
    assertEqual(controlFloorMin, 0.5, 'p2p-scattered declares the control floor');
    assertEqual(responseSettleGapMs, 3000, 'p2p-scattered declares the 7c settle gap');
    assertEqual(JSON.stringify(scatteredBars), JSON.stringify(peer.bars), 'p2p-scattered has D4 bars besides the floor');
    // `drift` is the pairwise figure; without `byte` the byte figure is withheld.
    assertEqual(JSON.stringify(conditions['p2p-naive'].figureKinds), JSON.stringify(['byte', 'drift']), 'p2p-naive publishes byte and drift');
    assert(!('figureKinds' in conditions['p2p-scattered']), 'p2p-scattered publishes byte only, as its source');
    // T1 item 5: these ran at the library's defaults before the product declared its
    // own, so each now declares them explicitly — a future run of it still behaves as
    // it did before this change.
    for (const name of ['p2p-naive', 'p2p-scattered']) {
      assertEqual(JSON.stringify(conditions[name].engineWindows), JSON.stringify(ENGINE_WINDOW_DEFAULTS), `${name} declares the library's windows`);
    }

    const qual = conditions.shakedown['p2p-qual'];
    const qualSource = conditions.shakedown['hostorigin-qual'];
    assertTopLevelEqualExcept(qualSource, qual, ['name', 'clients', 'bars', 'peerExchange', 'positionOffsetMsByClient', 'feeds', 'engineWindows'], 'p2p qualification source');
    assertEqual(JSON.stringify(qual.positionOffsetMsByClient), JSON.stringify({ c01: 0, c02: 30000, c03: 60000 }), 'p2p qualification offsets');
    assertEqual(JSON.stringify(qual.engineWindows), JSON.stringify(ENGINE_WINDOW_DEFAULTS), 'p2p qualification declares the library\'s windows');
  });

  await check('harness peer conditions: byte control bypasses the absent peer agreement bar', async () => {
    const tags = ['c01'];
    const host = evaluateByteControl({ bars: conditions['hostorigin-nop2p'].bars, tags, figures: {} });
    const peerControl = evaluateByteControl({ bars: peer.bars, tags, figures: {} });
    assert(host.some((entry) => entry.reason === 'origin-client-agreement-unavailable'), 'host arm still evaluates origin agreement');
    assertEqual(peerControl.some((entry) => entry.reason.startsWith('origin-client-agreement')), false, 'peer arm bypasses absent origin agreement');
    assertEqual(peerControl.some((entry) => entry.reason.startsWith('peer-byte-control')), false, 'peer arm has no peer-fraction control');
  });

  await check('harness peer arm: host setup is extended with peer acquisition', async () => {
    const host = armFor(conditions['hostorigin-nop2p']);
    const peerArm = armFor(peer);
    assert(Object.isFrozen(peerArm), 'peer arm is frozen');
    assertEqual(peerArm.runDirPrefix, '8b2', 'peer run prefix');
    assertEqual(peerArm.hostTag, host.hostTag, 'peer arm retains host tab');
    assertEqual(peerArm.prepareTopology, host.prepareTopology, 'peer arm inherits topology preparation');
    assertEqual(peerArm.openSessions, host.openSessions, 'peer arm inherits host session');
    assertEqual(JSON.stringify(peerArm.members(peer).declaredRoles), JSON.stringify(['host', 'viewer', 'viewer', 'viewer', 'viewer', 'viewer']), 'peer roles retain c00 host');
  });

  await check('harness peer arm: offset and peer-log refusals distinguish their twins', async () => {
    const inactive = validEvidence({ peerReadings: { ...validEvidence().peerReadings, c01: { ...validEvidence().peerReadings.c01, peerExchange: 'off' } } });
    const inactiveTwin = validEvidence();
    assertPeerReason(inactive, 'peer-exchange-inactive', inactiveTwin, 'inactive peer exchange');

    const unavailable = validEvidence({ peerReadings: { ...validEvidence().peerReadings, c01: { ...validEvidence().peerReadings.c01, attribution: 'unavailable' } } });
    assertPeerReason(unavailable, 'peer-attribution-unavailable', validEvidence(), 'unavailable peer attribution');

    const discarded = validEvidence({ peerLogHealth: { c01: { missed: 1, reset: false }, c02: { missed: 0, reset: false } } });
    assertPeerReason(discarded, 'peer-log-discarded-records', validEvidence(), 'discarded peer log');

    const reset = validEvidence({ peerLogHealth: { c01: { missed: 0, reset: true }, c02: { missed: 0, reset: false } } });
    assertPeerReason(reset, 'peer-log-reset', validEvidence(), 'reset peer log');

    const anomaly = validEvidence({ peerRecords: { c01: [{ kind: 'anomaly', reason: 'constructed' }], c02: [] } });
    assertPeerReason(anomaly, 'peer-anomaly-records', validEvidence(), 'peer anomaly record');

    const offset = validEvidence({ peerReadings: { ...validEvidence().peerReadings, c01: { ...validEvidence().peerReadings.c01, positionOffset: { ms: 1, error: null } } } });
    const offsetReason = refusal(offset).find((entry) => entry.reason === 'position-offset-mismatch');
    assert(offsetReason, 'position offset mismatch fires');
    assertEqual(JSON.stringify(offsetReason.scope), JSON.stringify(['byte', 'drift']), 'position offset mismatch scopes byte and drift');
    assertEqual(refusal(validEvidence()).some((entry) => entry.reason === 'position-offset-mismatch'), false, 'position offset twin stays silent');

    const build = validEvidence({ peerReadings: { ...validEvidence().peerReadings, c02: { ...validEvidence().peerReadings.c02, buildId: 'build-b' } } });
    const buildReason = refusal(build).find((entry) => entry.reason === 'build-mismatch');
    assert(buildReason, 'build mismatch fires');
    assertEqual(JSON.stringify(buildReason.scope), JSON.stringify(['byte', 'drift']), 'build mismatch scopes byte and drift');
    assertEqual(refusal(validEvidence()).some((entry) => entry.reason === 'build-mismatch'), false, 'build mismatch twin stays silent');
  });

  await check('harness peer arm: a late viewer is refused by name at the playback deadline', async () => {
    const result = evaluateRefusals({
      condition: { publishes: false, bars: {} }, declaredClientTags: ['c01', 'c02'],
      clients: { c01: {}, c02: {} },
      startWait: { deadlineMs: 1000, playingAtMs: { c01: 900, c02: null } },
    });
    const found = result.reasons.find((entry) => entry.reason === 'client-did-not-start');
    assert(found, 'late viewer refusal fires');
    assertEqual(found.tag, 'c02', 'late viewer tag is named');
    assertEqual(JSON.stringify(found.scope), JSON.stringify(['byte', 'drift']), 'late viewer refusal scopes both figures');
    const twin = evaluateRefusals({
      condition: { publishes: false, bars: {} }, declaredClientTags: ['c01', 'c02'],
      clients: { c01: {}, c02: {} },
      startWait: { deadlineMs: 1000, playingAtMs: { c01: 900, c02: 950 } },
    });
    assertEqual(twin.reasons.some((entry) => entry.reason === 'client-did-not-start'), false, 'all-playing twin stays silent');
  });
}
