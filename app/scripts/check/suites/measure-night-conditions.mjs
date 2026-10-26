import { assert, assertEqual, check } from '../harness.mjs';
import { conditionForName, conditionValidationReason } from '../../harness-run.mjs';
import { expandQdiscs } from '../../../harness/apply-qdisc.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const withoutReading = (value) => {
  const copy = clone(value);
  delete copy.reading;
  return copy;
};
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const tbf = (container, params) => ({
  container,
  network: 'wa-media',
  interface: '<resolved at runtime>',
  direction: 'egress',
  discipline: 'tbf',
  order: 1,
  params,
});
const netem = (container, params) => ({
  container,
  network: 'wa-media',
  interface: '<resolved at runtime>',
  direction: 'egress',
  discipline: 'netem',
  order: 2,
  params,
});
const conditions = [
  ['13d-a-five', '12c2-healthy-2s', () => {}],
  ['13d-a-ten', '11a2-ten-2s', () => {}],
  ['13d-a2-two', '13d-a-five', (value) => {
    value.clients = 2;
    value.positionOffsetMsByClient = { c01: 0, c02: 0 };
  }],
  ['13d-a2-three', '13d-a-five', (value) => {
    value.clients = 3;
    value.positionOffsetMsByClient = { c01: 0, c02: 0, c03: 0 };
  }],
  ['13d-b-nop2p-20', '11a2-nop2p-4s', (value) => {
    const healthy = conditionForName('13d-a-five');
    value.content = clone(healthy.content);
    value.runLengthMs = healthy.runLengthMs;
    value.excludedPrefixMs = healthy.excludedPrefixMs;
    value.measureWindowMs = healthy.measureWindowMs;
    value.qdiscs = [clone(value.qdiscs[0]), clone(healthy.qdiscs[1])];
    value.figureKinds = ['byte', 'drift'];
  }],
  ['13d-b-nop2p-10', '13d-b-nop2p-20', (value) => {
    value.qdiscs[0].params = { rate: '10mbit', burst: '32kbit', latency: '400ms' };
    value.capacityMbps = 10;
  }],
  ['13d-b-product-20', '13d-a-five', (value) => {
    value.qdiscs[0].params = { rate: '20mbit', burst: '64kbit', latency: '400ms' };
    value.capacityMbps = 20;
  }],
  ['13d-e-product', '11a2-seek-2s', () => {}],
  ['13d-e-control', '13d-e-product', (value) => { value.assignmentControl = '8b'; }],
  ['13d-l-loss5', '13d-a-five', (value) => {
    value.qdiscs.push(netem('origin', { loss: '5%' }), netem('client', { loss: '5%' }));
    value.criterion = { statistic: 'p99', targetMs: 100 };
  }],
  ['13d-d-delay25', '13d-a-five', (value) => {
    value.qdiscs.push(netem('origin', { delay: '25ms' }), netem('client', { delay: '25ms' }));
  }],
  ['13d-j-join', '11a2-join-2s', () => {}],
  ['13d-j-cut', '11a2-leave-silent-2s', (value) => {
    value.rosterEvent = { kind: 'leave-supplier-silent', at: 'measure-window-start' };
  }],
];
const diagnostics = [
  'shakedown/13d-d-diag',
  'shakedown/13d-l-diag',
  'shakedown/13d-e-check',
  'shakedown/13d-j-cut',
];

export default async function measureNightConditionsSuite() {
  await check('13d: conditions copy their declared archived base and factor', async () => {
    for (const [name, baseName, factor] of conditions) {
      const actual = conditionForName(name);
      const expected = withoutReading(conditionForName(baseName));
      expected.name = name;
      expected.publishes = true;
      factor(expected);
      assertEqual(conditionValidationReason(actual), null, `${name} passes condition validation`);
      assertEqual(canonical(actual), canonical(expected), `${name} equals its factored base`);
    }
  });

  await check('13d: every condition has the shared two-second content', async () => {
    const names = [...conditions.map(([name]) => name), ...diagnostics];
    const identities = new Set();
    const targetSeconds = new Set();
    for (const name of names) {
      const content = conditionForName(name).content;
      identities.add(content?.identity);
      targetSeconds.add(content?.targetSeconds);
    }
    assertEqual(identities.size, 1, 'all 13d conditions share one content identity');
    assertEqual([...identities][0], conditionForName('13d-a-five').content.identity, 'the shared identity is A5');
    assertEqual(targetSeconds.size, 1, 'all 13d conditions share one target duration');
    assertEqual([...targetSeconds][0], 2, 'the target duration is two seconds');
  });

  await check('13d: loss and delay expand paired tbf and netem rows', async () => {
    const expectedContainers = ['origin', 'c01', 'c02', 'c03', 'c04', 'c05'];
    for (const [name, parameter] of [['13d-l-loss5', { loss: '5%' }], ['13d-d-delay25', { delay: '25ms' }]]) {
      const rows = expandQdiscs(conditionForName(name));
      const byContainer = new Map();
      const kinds = new Set();
      const containers = new Set();
      for (const row of rows) {
        containers.add(row.container);
        kinds.add(`${row.discipline}:${row.order}`);
        if (!byContainer.has(row.container)) byContainer.set(row.container, []);
        byContainer.get(row.container).push(row);
      }
      assertEqual(rows.length, 12, `${name} expands to twelve rows`);
      assertEqual(kinds.has('tbf:1'), true, `${name} has order-one tbf rows`);
      assertEqual(kinds.has('netem:2'), true, `${name} has order-two netem rows`);
      assertEqual(JSON.stringify([...containers].sort()), JSON.stringify([...expectedContainers].sort()), `${name} shapes every container`);
      for (const container of expectedContainers) {
        const pair = byContainer.get(container);
        assertEqual(pair.length, 2, `${name} has one pair for ${container}`);
        assertEqual(pair.filter((row) => row.discipline === 'tbf' && row.order === 1).length, 1, `${name} has tbf for ${container}`);
        assertEqual(JSON.stringify(pair.find((row) => row.discipline === 'netem')?.params), JSON.stringify(parameter),
          `${name} declares the stress parameter for ${container}`);
      }
    }
  });

  await check('13d: no-P2P arms shape one origin and five ten-megabit viewers', async () => {
    for (const name of ['13d-b-nop2p-20', '13d-b-nop2p-10']) {
      const condition = conditionForName(name);
      const rows = expandQdiscs(condition);
      const byContainer = new Map(rows.map((row) => [row.container, row]));
      assert(condition.peerExchange !== true, `${name} does not enable peer exchange`);
      assert(!Object.prototype.hasOwnProperty.call(condition, 'positionOffsetMsByClient'), `${name} has no position offsets`);
      assertEqual(rows.length, 6, `${name} expands to one origin and five client rows`);
      assertEqual(byContainer.get('origin').params.rate, condition.qdiscs[0].params.rate, `${name} keeps its origin rate`);
      assertEqual([...byContainer.entries()].filter(([container]) => container.startsWith('c')).length, 5,
        `${name} expands all five client rows`);
      assert([...byContainer.entries()].filter(([container, row]) => container.startsWith('c') && row.params.rate === '10mbit').length === 5,
        `${name} keeps viewers at ten megabits`);
    }
  });
}
