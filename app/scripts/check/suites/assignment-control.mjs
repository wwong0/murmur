// 9b design.md D4, D6: the 8b control declared and checked on every page, and a
// slow viewer's own qdisc row applied, read back and published as its own rate.

import { assert, assertEqual, check } from '../harness.mjs';
import {
  assignmentControlReason, controlInjection, controlRefusals, readControls,
} from '../../harness/assignment-control.mjs';
import { armFor } from '../../harness/arms.mjs';
import { conditionValidationReason } from '../../harness-run.mjs';
import { applyQdiscs, expandQdiscs } from '../../../harness/apply-qdisc.mjs';

const PAGES = Array.from({ length: 11 }, (_, index) => `c${String(index).padStart(2, '0')}`);
const EIGHT_B = { control: '8b', supplied: true, error: null };
const PRODUCT = { control: 'product', supplied: false, error: null };
const DECLARING = { delivery: 'host', peerExchange: true, assignmentControl: '8b' };
const HEADLINE = { delivery: 'host', peerExchange: true };

// Two readings of the same eleven pages, 600 s apart; `change` edits one page of one reading.
function readings(value, change = null) {
  const pair = [1_000, 601_000].map((atMs) => ({ atMs, byPage: Object.fromEntries(PAGES.map((page) => [page, { ...value }])) }));
  if (change) pair[change.reading].byPage[change.page] = change.value;
  return pair;
}

const named = (refusals) => refusals.map((entry) => `${entry.reason}:${entry.page}`).sort().join(' ');

async function thrownBy(run) {
  try { await run(); } catch (error) { return error; }
  return null;
}

export default async function assignmentControlSuite() {
  await check('assignment control: a condition declares 8b with peer exchange, or nothing', async () => {
    assertEqual(assignmentControlReason(DECLARING), null, '8b with peer exchange is valid');
    assertEqual(assignmentControlReason(HEADLINE), null, 'no declaration is valid');
    assertEqual(assignmentControlReason({ ...DECLARING, assignmentControl: 'product' }), 'assignment-control-invalid', 'no other value is declared');
    assertEqual(assignmentControlReason({ ...DECLARING, peerExchange: false }), 'assignment-control-invalid', '8b without peer exchange is refused');
    assertEqual(conditionValidationReason({ ...DECLARING, assignmentControl: true }), 'assignment-control-invalid', 'the runner\'s validation carries it');
    assertEqual(conditionValidationReason(DECLARING), null, 'and passes a declaring condition');
    assertEqual(controlInjection(DECLARING), 'globalThis.__waControl = "8b";', 'the declaring condition\'s pre-load script');
    assertEqual(controlInjection(HEADLINE), null, 'a headline condition supplies nothing');
  });

  await check('assignment control: every page is read, and a malformed reading is a hard error', async () => {
    const asked = [];
    const tab = (value) => ({ evaluate: async (source) => { asked.push(source); return value; } });
    const reading = await readControls({ c00: tab({ ...EIGHT_B, extra: 1 }), c01: tab(EIGHT_B) }, { now: () => 42 });
    assertEqual(JSON.stringify(reading), JSON.stringify({ byPage: { c00: EIGHT_B, c01: EIGHT_B }, atMs: 42 }), 'both pages, by tag, at the instant read');
    assertEqual(asked.join(' '), '__app.control() __app.control()', 'each page was asked for its control');
    const malformed = await thrownBy(() => readControls({ c00: tab(EIGHT_B), c01: tab({ supplied: true, error: null }) }));
    assert(malformed?.message.startsWith('assignment-control-reading-malformed: c01'), 'control: undefined is a hard error naming the page');
    const absent = await thrownBy(() => readControls({ c00: tab(null) }));
    assert(absent?.message.startsWith('assignment-control-reading-malformed: c00'), 'a page with no control() result is a hard error');
    const inRefusals = await thrownBy(async () => controlRefusals(DECLARING, readings(EIGHT_B, { reading: 1, page: 'c03', value: { control: undefined, supplied: true, error: null } })));
    assert(inRefusals?.message.startsWith('assignment-control-reading-malformed: c03'), 'and it is one in the refusal check, never a refusal');
  });

  await check('assignment control: a page that did not run the declared control refuses the run', async () => {
    assertEqual(controlRefusals(DECLARING, readings(EIGHT_B)).length, 0, 'all eleven pages on 8b under a declaring condition: no refusal');
    assertEqual(controlRefusals(HEADLINE, readings(PRODUCT)).length, 0, 'all eleven on the product under a headline condition: no refusal');
    // The pairs below differ from the passing set in one page of one reading.
    const oneProduct = controlRefusals(DECLARING, readings(EIGHT_B, { reading: 0, page: 'c04', value: PRODUCT }));
    assertEqual(named(oneProduct), 'assignment-control-changed:c04 assignment-control-mismatch:c04', 'one viewer on the product is refused, naming it');
    const mismatch = oneProduct.find((entry) => entry.reason === 'assignment-control-mismatch');
    assertEqual(`${mismatch.declared}/${mismatch.control}`, '8b/product', 'with the declared and the read value');
    const supplied = controlRefusals(HEADLINE, readings(PRODUCT, { reading: 0, page: 'c07', value: EIGHT_B }));
    assert(named(supplied).includes('assignment-control-supplied:c07'), 'a headline run with one page supplied the switch is refused');
    const erred = { control: 'product', supplied: true, error: 'control-must-be-8b' };
    const error = controlRefusals(DECLARING, [readings(EIGHT_B)[0]].map((reading) => ({ ...reading, byPage: { ...reading.byPage, c02: erred } })));
    assertEqual(named(error), 'assignment-control-error:c02 assignment-control-mismatch:c02', 'a page reporting an error is refused');
    const changed = controlRefusals(DECLARING, readings(EIGHT_B, { reading: 1, page: 'c09', value: PRODUCT }))
      .find((entry) => entry.reason === 'assignment-control-changed');
    assertEqual(`${changed.page}:${changed.before.control}>${changed.after.control}`, 'c09:8b>product', 'two readings that differ name the page and both values');
    assertEqual(controlRefusals(DECLARING, [])[0].reason, 'assignment-control-unread', 'a run that kept no reading is refused');
    // 10b: a joiner is absent from the first reading and a leaver from the last, and only they may be.
    const joined = readings(EIGHT_B);
    delete joined[0].byPage.c05;
    assertEqual(named(controlRefusals(DECLARING, joined)), 'assignment-control-changed:c05', 'a page in one reading only is a change');
    assertEqual(controlRefusals(DECLARING, joined, { rosterPage: 'c05' }).length, 0, 'unless it is the page the roster event added');
    assertEqual(named(controlRefusals(DECLARING, joined, { rosterPage: 'c04' })), 'assignment-control-changed:c05', 'and no other page is excused by it');
    const switched = controlRefusals(DECLARING, readings(EIGHT_B, { reading: 1, page: 'c05', value: PRODUCT }), { rosterPage: 'c05' });
    assertEqual(named(switched), 'assignment-control-changed:c05 assignment-control-mismatch:c05', 'the event\'s page read twice and differing is still a change');
    // Prevention claim: a headline run that used the switch cannot be accepted.
    // Opportunity: a headline condition with page c07 reading 8b, supplied.
    // Action boundary: controlRefusals. Mutation, with assignment-control.mjs copied
    // aside: the `supplied` clause dropped. `npm run check` turned 'a headline run
    // with one page supplied the switch is refused' red, and the arm's 'the arm
    // refuses the run, naming the page' with it. Restored from the copy, diff
    // empty; green again. The case below is the same clause with no mismatch beside it.
    const suppliedOnProduct = controlRefusals(HEADLINE, [{ atMs: 1, byPage: { c07: { control: 'product', supplied: true, error: null } } }]);
    assertEqual(named(suppliedOnProduct), 'assignment-control-supplied:c07', 'a page supplied the switch and still on the product is refused');
  });

  await check('assignment control: the host arm\'s refusals carry the control check', async () => {
    const reasonsFor = (assignmentControl) => {
      const reasons = [];
      armFor(HEADLINE).refusals({ condition: { ...HEADLINE, clients: 0 }, declaredClientTags: [], clients: {},
        roomFinal: { counters: { byClient: {} } }, ...assignmentControl },
        (reason, scope, detail) => reasons.push({ reason, scope, ...detail }));
      return reasons.filter((entry) => entry.reason.startsWith('assignment-control'));
    };
    const refused = reasonsFor({ assignmentControl: { readings: readings(PRODUCT, { reading: 0, page: 'c07', value: EIGHT_B }) } });
    assert(refused.some((entry) => entry.reason === 'assignment-control-supplied' && entry.page === 'c07'), 'the arm refuses the run, naming the page');
    assertEqual(refused[0].scope.join(','), 'byte,drift', 'for both figure kinds');
    assertEqual(reasonsFor({ assignmentControl: { readings: readings(PRODUCT) } }).length, 0, 'and passes eleven product pages');
    assertEqual(reasonsFor({}).length, 0, 'evidence retained before 9b carries no reading and is not judged by it');
  });

  await check('assignment control: per-viewer qdisc rows apply, read back and publish each viewer\'s own rate', async () => {
    const rates = { c01: '10mbit', c02: '10mbit', c03: '10mbit', c04: '10mbit', c05: '1mbit' };
    const shown = { '10mbit': '10Mbit', '1mbit': '1Mbit' };
    const condition = { clients: 5, qdiscs: Object.entries(rates).map(([container, rate]) => ({ container, network: 'wa-media',
      direction: 'egress', discipline: 'tbf', order: 1, params: { rate, burst: '32kbit', latency: '400ms' } })) };
    const expanded = expandQdiscs(condition);
    assertEqual(expanded.map((row) => row.container).join(','), 'c01,c02,c03,c04,c05', 'rows naming viewers singly are kept as declared');
    assert(expanded.every((row) => row.declaredContainer === undefined), 'none is the expansion of a client row');
    const added = {};
    const exec = (argv) => {
      const [, , container, ...command] = argv;
      const text = command.join(' ');
      if (text.startsWith('ip -json')) return JSON.stringify([{ ifname: 'eth1', addr_info: [{ family: 'inet', local: `172.30.0.${10 + Number(container.slice(-1))}`, prefixlen: 24 }] }]);
      if (text.startsWith('tc qdisc del')) return '';
      if (text.startsWith('tc qdisc add')) { added[container] = command[command.indexOf('rate') + 1]; return ''; }
      if (text.startsWith('tc qdisc show')) return `qdisc tbf 10: root refcnt 2 rate ${shown[added[container]]} burst 4Kb lat 400ms`;
      throw new Error(`unexpected exec: ${text}`);
    };
    const containers = Object.fromEntries(Object.keys(rates).map((tag) => [tag, `wa-${tag}`]));
    const records = applyQdiscs({ condition, containers, exec, subnets: new Map([['wa-media', '172.30.0.0/24']]) });
    assertEqual(records.map((record) => `${record.containerRole}=${record.readBack.readings.rate.got}`).join(' '),
      'c01=10000000 c02=10000000 c03=10000000 c04=10000000 c05=1000000', 'each viewer\'s record carries the rate the kernel read back');
    const wrong = await thrownBy(async () => applyQdiscs({ condition, containers,
      exec: (argv) => (argv.includes('show') && argv.includes('tc') ? 'qdisc tbf 10: root refcnt 2 rate 10Mbit burst 4Kb lat 400ms' : exec(argv)),
      subnets: new Map([['wa-media', '172.30.0.0/24']]) }));
    assertEqual(wrong?.name, 'QdiscMismatch', 'a slow viewer read back at the others\' rate stops the run');
    assert(wrong.message.startsWith('wa-c05/'), 'naming the slow viewer\'s container');
  });
}
