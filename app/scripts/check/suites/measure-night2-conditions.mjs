import { assert, assertEqual, check } from '../harness.mjs';
import { conditions, conditionForName, conditionValidationReason } from '../../harness-run.mjs';
import { expandQdiscs } from '../../../harness/apply-qdisc.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const netem = (container, params) => ({ container, network: 'wa-media', interface: '<resolved at runtime>',
  direction: 'egress', discipline: 'netem', order: 2, params });

const nightTwoConditions = [
  ['13e-w-long', '13d-a-five', (value) => { value.runLengthMs = 3_600_000; value.measureWindowMs = 3_420_000; value.retainedBytesMax = 1_073_741_824; }],
  ['13e-u-host5', '13d-a-five', (value) => { value.qdiscs[0].params = { rate: '5mbit', burst: '32kbit', latency: '400ms' }; value.capacityMbps = 5; }],
  ['13e-u-viewers3', '13d-a-five', (value) => { value.qdiscs[1].params.rate = '3mbit'; }],
  ['13e-u-one1', '13d-a-five', (value) => {
    const client = clone(value.qdiscs[1]);
    value.qdiscs = [value.qdiscs[0], ...Array.from({ length: 5 }, (_, index) => ({ ...clone(client),
      container: `c${String(index + 1).padStart(2, '0')}`,
      ...(index === 4 ? { params: { ...clone(client.params), rate: '1mbit' } } : {}) }))];
  }],
  ['13e-q-product', '13d-a-five', (value) => {
    value.excludedPrefixMs = 120_000; value.measureWindowMs = 240_000; value.runLengthMs = 480_000;
    value.capacitySchedule = { dropAfterReadyMs: 120_000,
      drop: { container: 'origin', network: 'wa-media', discipline: 'tbf', params: { rate: '1mbit', burst: '32kbit', latency: '400ms' } },
      edgeHeldAheadMsBelow: 1, ceilingMs: 120_000,
      rise: { container: 'origin', network: 'wa-media', discipline: 'tbf', params: { rate: '10mbit', burst: '32kbit', latency: '400ms' } },
      recordAfterRiseMs: 240_000 };
  }],
  ['13e-q-control', '13e-q-product', (value) => { value.assignmentControl = '8b'; }],
  ['13e-t-skew60', '13d-a-five', (value) => { value.qdiscs.push(netem('c05', { delay: '60ms' })); }],
  ['13e-k-half', '13d-a-five', (value) => {
    value.disturbance = { kind: 'local-pause-play', clients: ['c03'], pauseMs: 500, at: 'measure-window-start', observationMs: 90_000 };
    value.figureKinds = ['byte']; delete value.criterion;
  }],
  ['13e-k-two', '13e-k-half', (value) => { value.disturbance.pauseMs = 2_000; }],
  ['13e-e10-product', '13d-e-product', (value) => {
    value.clients = 10;
    value.positionOffsetMsByClient = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`c${String(index + 1).padStart(2, '0')}`, 0]));
  }],
  ['13e-e10-control', '13e-e10-product', (value) => { value.assignmentControl = '8b'; }],
  ['13e-nd-defaults', '13d-a-five', (value) => {
    value.engineWindows = { highDemandTimeWindow: 15, httpDownloadTimeWindow: 3_000, p2pDownloadTimeWindow: 6_000 };
    value.headroomFraction = 'unpaced';
  }],
  ['13e-b2-nop2p-10', '13d-b-nop2p-10', () => {}],
  ['13e-b2-nop2p-20', '13d-b-nop2p-20', () => {}],
];
const nightTwoDiagnostics = ['shakedown/13e-t-diag', 'shakedown/13e-q-pilot', 'shakedown/13e-e10-check'];

function expectedCondition(name, baseName, factor, publishes = true) {
  const expected = clone(conditionForName(baseName));
  expected.name = name;
  expected.publishes = publishes;
  factor(expected);
  if (expected.peerExchange === true) expected.excusals = { ...expected.excusals, bytelessUnreceivedResponse: true };
  return expected;
}

export default async function measureNight2ConditionsSuite() {
  await check('13e: conditions validate and equal their factored bases', async () => {
    for (const [name, baseName, factor] of nightTwoConditions) {
      const actual = conditionForName(name);
      assertEqual(conditionValidationReason(actual), null, `${name} passes condition validation`);
      assertEqual(canonical(actual), canonical(expectedCondition(name, baseName, factor)), `${name} equals its factored base`);
    }
  });

  await check('13e: diagnostics copy their scored arms and publish no figures', async () => {
    const bases = { 'shakedown/13e-t-diag': ['13e-t-skew60', (value) => {
      value.runLengthMs = 180_000; value.excludedPrefixMs = 120_000; value.measureWindowMs = 60_000;
    }], 'shakedown/13e-q-pilot': ['13e-q-product', () => {}], 'shakedown/13e-e10-check': ['13e-e10-control', () => {}] };
    for (const name of nightTwoDiagnostics) {
      const [baseName, factor] = bases[name];
      const actual = conditionForName(name);
      assertEqual(conditionValidationReason(actual), null, `${name} passes condition validation`);
      assertEqual(canonical(actual), canonical(expectedCondition(name, baseName, factor, false)), `${name} equals its diagnostic base`);
    }
  });

  await check('13e: qdiscs expand the skew and one-viewer rate factors', async () => {
    const skew = expandQdiscs(conditionForName('13e-t-skew60'));
    const skewTbf = skew.filter((row) => row.discipline === 'tbf' && row.order === 1);
    const skewNetem = skew.filter((row) => row.discipline === 'netem');
    assertEqual(skewTbf.length, 6, 'skew has six order-one tbf rows');
    assertEqual(skewNetem.length, 1, 'skew has one netem row');
    assertEqual(skewNetem[0]?.container, 'c05', 'skew delays c05');
    assertEqual(skewNetem[0]?.params.delay, '60ms', 'skew declares 60ms');
    const one = expandQdiscs(conditionForName('13e-u-one1'));
    const rates = Object.fromEntries(one.filter((row) => row.container.startsWith('c')).map((row) => [row.container, row.params.rate]));
    assertEqual(rates.c05, '1mbit', 'one-viewer c05 is 1mbit');
    assertEqual(JSON.stringify(['c01', 'c02', 'c03', 'c04'].map((tag) => rates[tag])), JSON.stringify(['10mbit', '10mbit', '10mbit', '10mbit']),
      'one-viewer c01-c04 stay at 10mbit');
  });

  await check('13e: excusal, identity and legacy condition boundaries stay explicit', async () => {
    const names = [...nightTwoConditions.map(([name]) => name), ...nightTwoDiagnostics];
    const peerExcusals = names.map((name) => conditionForName(name).peerExchange === true
      ? conditionForName(name).excusals?.bytelessUnreceivedResponse : undefined);
    assert(peerExcusals.filter((value) => value !== undefined).every((value) => value === true), 'every peer 13e arm declares the unreceived excusal');
    assertEqual(conditionForName('13e-b2-nop2p-10').excusals?.bytelessUnreceivedResponse, undefined, 'B2 10 has no peer excusal');
    assertEqual(conditionForName('13e-b2-nop2p-20').excusals?.bytelessUnreceivedResponse, undefined, 'B2 20 has no peer excusal');
    const identities = names.map((name) => conditionForName(name).content?.identity);
    assert(identities.every((identity) => identity === conditionForName('13d-a-five').content.identity), 'every 13e arm keeps the A5 identity');
    const legacy = Object.entries(conditions).flatMap(([group, value]) => group === 'shakedown'
      ? Object.entries(value).filter(([name]) => name.startsWith('13d-')).map(([, condition]) => condition)
      : group.startsWith('13d-') ? [value] : []);
    assert(legacy.every((condition) => condition.excusals?.bytelessUnreceivedResponse !== true), '13d conditions do not gain the 13e excusal');
  });
}
