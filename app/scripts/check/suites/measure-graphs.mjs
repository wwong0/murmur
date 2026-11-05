import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { driftLabel, pct, runMark } from '../../graphs/rules.mjs';
import { HOUR, normaliseVerdicts } from '../../graphs/sources.mjs';
import { BANNED, conditionWords, reasonText, setupLines } from '../../graphs/plain.mjs';
import { peerBytesTrace } from '../../graphs/peer-bytes-trace.mjs';
import * as sharing from '../../graphs/fig-sharing.mjs';
import * as room from '../../graphs/fig-room-size.mjs';
import * as sync from '../../graphs/fig-sync.mjs';
import * as waits from '../../graphs/fig-waits.mjs';
import * as connection from '../../graphs/fig-connection.mjs';
import * as recovery from '../../graphs/fig-recovery.mjs';
import * as weaker from '../../graphs/fig-weaker.mjs';
import * as hour from '../../graphs/fig-hour.mjs';
import { alsoTested, limits } from '../../graphs/notes.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export function fixture(rows, tests = {}) {
  const batches = {}, runs = {};
  for (const batch of ['13d', '13e', '13f']) {
    batches[batch] = {
      ledger: { runs: [] },
      verdicts: { entries: [], tests: tests[batch] ?? {} },
      readings: { runs: {} },
      classes: {},
    };
  }
  for (const [index, r] of rows.entries()) {
    const batch = batches[r.condition.slice(0, 3)],
      directory = r.directory ?? `${r.condition}-${index}`,
      viewers = r.viewers ?? 5,
      cap = r.cap ?? 10;
    const qdiscs = [
      { container: 'origin', direction: 'egress', discipline: 'tbf', params: { rate: `${cap}mbit` } },
      { container: 'client', direction: 'egress', discipline: 'tbf', params: { rate: '10mbit' } },
      ...(r.netem ?? []),
    ];
    const figures = {
      hostUploadMultiplier: r.value,
      peerFractionAggregate: r.peer ?? 0.8,
      uplinkUtilisationMean: r.uplink ?? 0.3,
      stallCountByClient: { c03: r.stalls ?? 0 },
      coverageRatioByClient: { c03: 1 },
      standingQueueDelayMsP50NearestRank: 0,
      ...(r.figures ?? {}),
    };
    const entry = {
      directory,
      condition: r.condition,
      valid: r.valid ?? true,
      reasons: r.reasons ?? [],
      figures,
    };
    batch.ledger.runs.push({
      directory,
      condition: r.condition,
      commit: 'abc',
      bundleBuildId: 'build',
      outcome: 'complete',
    });
    batch.verdicts.entries.push(entry);
    batch.readings.runs[directory] = r.readings ?? {};
    runs[directory] = {
      manifest: {
        condition: {
          clients: viewers,
          qdiscs,
          runLengthMs: 60000,
          excludedPrefixMs: 10000,
          measureWindowMs: 50000,
        },
        window: { startMs: 10000, opensAt: r.opensAt ?? 'capacity-schedule-rise' },
      },
      content: { totalBytes: 330000, duration: 1, segmentSeconds: 4 },
      schedule: {
        drop: { readBack: { rate: { got: 1000000 } }, appliedAtMs: 1 },
        rise: { readBack: { rate: { got: 10000000 } }, appliedAtMs: 120001 },
      },
    };
  }
  return { batches, runs, traces: {} };
}
function throws(fn, expected) {
  let message = '';
  try {
    fn();
  } catch (e) {
    message = e.message;
  }
  assert(message.includes(expected), `expected ${expected}: ${message}`);
}
function validSvg(module, data) {
  const s = module.svg(data);
  assert(
    s.startsWith('<svg') && s.includes('viewBox=') &&
      s.includes(`<title>${module.TITLE.replaceAll('&', '&amp;').replaceAll("'", '&apos;')}</title>`),
    `SVG ${module.ID}`,
  );
  assert(!BANNED.test(s), `plain SVG ${module.ID}`);
  assert(!BANNED.test(module.notes(data)), `plain notes ${module.ID}`);
  return s;
}
export const lab = (p99) => {
  return ({
    'lab-drift': {
      overall: { absMedianMs: 0.2, absP99Ms: p99, worstPair: 'c01|c03' },
      pairs: [{ left: 'c01', right: 'c03', floorMs: 16.7, lowerMs: 0.2, upperMs: 16.8 }],
    },
    'gap-count': { viewers: { c03: { playingMs: 1, secondsAbove40PerHour: 0, secondsAbove100PerHour: 0 } } },
  });
};

export default async function measureGraphsSuite() {
  await check('graphs: rules and setup', async () => {
    // 101.57% rounds to 102%, and 499.97% to 500%.
    assertEqual(pct(1.0157), '102%', 'rounded percent');
    assertEqual(pct(4.9997), '500%', 'rounded percent');
    assertEqual(driftLabel(0.2, 16.7), '< 17 ms', 'floor');
    assertEqual(driftLabel(16.8, 16.7), '17 ms', 'above floor');
    assert(!runMark({ valid: false, reasons: ['bad'] }, 1).filled, 'invalid mark');
    assertEqual(
      reasonText({ valid: false, reasons: ['x'] }, null),
      'excluded by an automatic check (x)',
      'unknown reason',
    );
    // A refused run keeps its own reason beside the multiplier's, each phrase once.
    assertEqual(
      reasonText({
        valid: false,
        reasons: ['status:refused', 'refusal:a', 'refusal:b'],
        figures: { hostUploadMultiplierRefusal: { reason: 'one-viewing-unavailable' } },
      }, null),
      "the test's own checks refused it; a viewer stopped playing, so there is no fair 'one viewing' to divide by",
      'refused run with a refused multiplier',
    );
    const v = normaliseVerdicts({ runs: [{ directory: 'a' }, { directory: 'b' }] }, {
      a: { figures: { x: 1 } },
    });
    assertEqual(v.entries[0].figures.x, 1, 'report');
    assertEqual(v.entries[1].figures, null, 'missing report');
    assert(
      setupLines([{
        viewers: 5,
        hostCapMbps: 10,
        viewerCaps: 'every viewer 10 Mbit/s',
        downloadsShaped: false,
        lossDelay: 'none',
        bitrateMbps: 2,
        durationMs: 'unrecorded',
        prefixMs: 1,
        windowMs: 1,
      }]).join(' ').includes('unrecorded'),
      'unrecorded',
    );
    assertEqual(conditionWords({ lossDelay: 'none' }), 'no network trouble', 'none');
    assertEqual(
      conditionWords({ lossDelay: ['loss 5% on origin', 'loss 5% on client'] }),
      '5% of data lost',
      'loss',
    );
    assertEqual(
      conditionWords({ lossDelay: ['delay 25ms on origin', 'delay 25ms on client'] }),
      'everyone 25 ms delayed',
      'delay',
    );
    assertEqual(
      conditionWords({ lossDelay: ['delay 60ms on c03'] }),
      'one viewer 60 ms farther away',
      'one delay',
    );
    throws(() => conditionWords({ lossDelay: ['loss 5% on c03'] }), 'unknown-netem');
  });
  await check('graphs: sharing and room sizes', async () => {
    const rows = [
      { condition: '13d-b-nop2p-20', cap: 20, value: 5 },
      { condition: '13d-b-nop2p-20', cap: 20, value: 5 },
      {
        condition: '13e-b2-nop2p-20',
        cap: 20,
        value: null,
        figures: { hostUploadMultiplierRefusal: { reason: 'one-viewing-unavailable' } },
      },
      { condition: '13d-b-product-20', cap: 20, value: 1 },
      { condition: '13d-b-product-20', cap: 20, value: 1.04 },
    ];
    // The two available no-sharing values have median 5; the two sharing values average 1.02.
    const d = sharing.data(fixture(rows));
    assertEqual(d.bars[0].value, 5, 'without median');
    assertNear(d.bars[1].value, 1.02, 1e-9, 'with median');
    assert(sharing.takeaway(d).includes('500%') && sharing.takeaway(d).includes('102%'), 'takeaway');
    assert(
      sharing.notes(d).includes("no fair 'one viewing'") &&
        sharing.notes(d).split('\n').filter((s) =>
            s.startsWith('| ') && !s.startsWith('| ---') && !s.startsWith('| Test')
          ).length === 5,
      'all rows retained',
    );
    validSvg(sharing, d);
    throws(
      () => sharing.data(fixture(rows.map((r) => r.value === 1.04 ? { ...r, cap: 10 } : r))),
      'mixed-regime:sharing',
    );
    throws(
      () =>
        sharing.data(fixture(rows.map((r) => r.condition === '13d-b-product-20' ? { ...r, value: 6 } : r))),
      'takeaway-unsupported:sharing',
    );
    const sizes = [{ condition: '13d-a2-two', viewers: 2, value: 1 }, {
      condition: '13d-a2-two',
      viewers: 2,
      value: 1.02,
    }, { condition: '13d-a-ten', viewers: 10, value: 1.1 }];
    const r = room.data(fixture(sizes));
    assertNear(r.bars[0].measured, 1.01, 1e-9, 'median 1.01');
    assertEqual(r.bars[0].outline, 2, 'two outline');
    assertEqual(r.bars[1].outline, 10, 'ten outline');
    assertEqual(r.bars[1].measured, 1.1, 'ten median');
    validSvg(room, r);
    throws(
      () => room.data(fixture(sizes.map((v) => v.viewers === 2 ? { ...v, value: 2.5 } : v))),
      'takeaway-unsupported:room-size',
    );
  });
  await check('graphs: sync and waits', async () => {
    const net = (kind, val, container) => {
      return ({
        discipline: 'netem',
        container,
        params: { [kind]: val },
        direction: 'egress',
      });
    };
    const rows = [
      { condition: '13d-a-five', readings: lab(0.2) },
      { condition: '13d-a-five', readings: lab(16.8) },
      {
        condition: '13d-l-loss5',
        netem: [net('loss', '5%', 'origin'), net('loss', '5%', 'client')],
        readings: lab(0.2),
      },
      {
        condition: '13d-d-delay25',
        netem: [net('delay', '25ms', 'origin'), net('delay', '25ms', 'client')],
        readings: lab(0.2),
      },
      { condition: '13e-t-skew60', netem: [net('delay', '60ms', 'c03')], readings: lab(42.9) },
      { condition: '13e-t-skew60', netem: [net('delay', '60ms', 'c03')], readings: lab(33.4) },
    ];
    // Worst values are 16.8 and 42.9, while the floor is 16.7.
    const d = sync.data(fixture(rows));
    assertEqual(d.bars[0].shown, 16.8, 'first width');
    assertEqual(d.bars[3].shown, 42.9, 'last width');
    const s = validSvg(sync, d);
    assert(
      !s.includes('0.2') && s.includes('16.7 ms') && s.includes('43 ms') && s.includes('&lt; 17 ms'),
      'floor and labels',
    );
    throws(
      () => sync.data(fixture(rows.map((r, i) => i === 0 ? { ...r, readings: lab(30) } : r))),
      'takeaway-unsupported:sync',
    );
    const starts = [4000, 5000, 6000].map((v) => ({
        condition: '13d-e-product',
        readings: { landings: { start: { waitMs: v }, seek: { waitMs: v } } },
      })
      ),
      joins = [3000, 3200].map((v) => ({
        condition: '13d-j-join',
        readings: {
          'event-clocks': {
            join: { entryToFirstFrameMs: 1000, firstFrameToInSyncMs: v - 1000, entryToInSyncMs: v },
          },
        },
      }));
    const w = waits.data(fixture([...starts, ...joins]));
    assertEqual(w.bars[0].value, 5000, 'start median');
    assertEqual(w.bars[2].value, 3100, 'join median');
    assert(!/aim|goal|target/i.test(validSvg(waits, w) + waits.takeaway(w) + waits.notes(w)), 'no target');
  });
  await check('graphs: connection, recovery and weaker', async () => {
    // 5 * 2.64 / 10 = 1.32; medians are 0.994 and 0.30.
    const rows = [0.995, 0.993].map((uplink) => ({
      condition: '13e-nd-defaults',
      uplink,
      readings: lab(16.8),
    })).concat([0.3, 0.29, 0.31].map((uplink) => ({ condition: '13d-a-five', uplink, readings: lab(16.8) })));
    const c = connection.data(fixture(rows));
    assertNear(c.bars[0].value, 1.32, 1e-9, 'worked out');
    assertNear(c.bars[1].value, 0.994, 1e-9, 'defaults');
    assertEqual(c.bars[2].value, 0.3, 'app');
    validSvg(connection, c);
    throws(
      () => connection.data(fixture(rows.map((r, i) => i === 0 ? { ...r, stalls: 1 } : r))),
      'takeaway-unsupported:connection',
    );
    throws(
      () => connection.data(fixture(rows.map((r) => r.condition === '13d-a-five' ? { ...r, uplink: 1 } : r))),
      'takeaway-unsupported:connection',
    );
    // "in-step": 30 ms is more than one refresh past the 16.7 ms floor.
    throws(
      () => connection.data(fixture(rows.map((r, i) => i === 0 ? { ...r, readings: lab(30) } : r))),
      'takeaway-unsupported:connection',
    );
    const pairRows = [
        { condition: '13e-q-product', directory: 'p0', stalls: 2 },
        { condition: '13e-q-control', directory: 'c0', stalls: 109 },
        { condition: '13e-q-product', directory: 'p1', stalls: 0 },
        { condition: '13e-q-control', directory: 'c1', stalls: 20 },
      ],
      input = fixture(pairRows);
    input.batches['13e'].verdicts.tests.Q = {
      pairs: [0, 1].map((i) => ({
        product: input.batches['13e'].verdicts.entries.find((e) => e.directory === `p${i}`),
        control: input.batches['13e'].verdicts.entries.find((e) => e.directory === `c${i}`),
      })),
    };
    const q = recovery.data(input);
    assertEqual(q.bars[0].current, 2, 'current');
    assertEqual(q.bars[0].earlier, 109, 'earlier');
    const image = validSvg(recovery, q);
    assert(image.includes('earlier version') && !/off-the-shelf|library/i.test(image), 'distinct comparison');
    input.batches['13e'].verdicts.tests.Q.pairs[0].product.figures.stallCountByClient = { c03: 109 };
    throws(() => recovery.data(input), 'takeaway-unsupported:recovery');
    input.batches['13e'].verdicts.tests.Q.pairs[0].product.figures.stallCountByClient = { c03: 2 };
    input.runs.p0.manifest.window.opensAt = 'other';
    throws(() => recovery.data(input), 'wrong-window:recovery');
    const u = fixture([
      { condition: '13d-a-five', peer: 0.8 },
      ...[0.793, 0.795].map((peer) => ({ condition: '13e-u-host5', cap: 5, peer })),
      ...[0.671, 0.665].map((peer) => ({ condition: '13e-u-one1', peer })),
      { condition: '13e-u-viewers3', peer: 0.3 },
    ]);
    const extra = u.batches['13e'].verdicts.entries.find((v) => v.condition === '13e-u-viewers3');
    u.runs[extra.directory].manifest.condition.qdiscs[1].params.rate = '3mbit';
    for (const e of u.batches['13e'].verdicts.entries.filter((v) => v.condition === '13e-u-one1')) {
      u.runs[e.directory].manifest.condition.qdiscs = [{
        container: 'origin',
        direction: 'egress',
        discipline: 'tbf',
        params: { rate: '10mbit' },
      }, { container: 'c03', direction: 'egress', discipline: 'tbf', params: { rate: '1mbit' } }];
    }
    const wd = weaker.data(u);
    assertNear(wd.bars[0].value, 0.794, 1e-9, 'first median');
    assertNear(wd.bars[1].value, 0.668, 1e-9, 'second median');
    assert(
      weaker.notes(wd).includes('every viewer uploads at 3 Mbit/s') &&
        !validSvg(weaker, wd).includes('every viewer uploads at 3 Mbit/s'),
      'notes only',
    );
    u.batches['13e'].verdicts.entries.find((v) => v.condition === '13e-u-host5').figures.stallCountByClient
      .c03 = 1;
    throws(() => weaker.data(u), 'takeaway-unsupported:weaker');
  });
  await check('graphs: hour bins and command refusals', async () => {
    // 100 and 50 bytes end in the same minute; aborted bytes do not count.
    const t = peerBytesTrace({
      manifest: { window: {} },
      binWidth: 60000,
      peerBytesByClient: {
        c03: [{ kind: 'attempt', end: 'loaded', source: 'http', endMs: 0, bytes: 100 }, {
          kind: 'attempt',
          end: 'loaded',
          source: 'p2p',
          peerId: 'private',
          endMs: 30000,
          bytes: 50,
        }],
      },
    });
    assertEqual(t.bins.length, 1, 'one bin');
    assertEqual(t.bins[0].hostBytes, 100, 'host');
    assertEqual(t.bins[0].peerBytesBySender['peer 1'], 50, 'peer');
    const short = peerBytesTrace({
      manifest: { window: {} },
      binWidth: 10000,
      peerBytesByClient: {
        c03: [
          { kind: 'attempt', end: 'loaded', source: 'http', endMs: 5000, bytes: 100 },
          { kind: 'attempt', end: 'loaded', source: 'p2p', peerId: 'a', endMs: 6000, bytes: 50 },
          { kind: 'attempt', end: 'loaded', source: 'p2p', peerId: 'b', endMs: 15000, bytes: 30 },
          { kind: 'attempt', end: 'aborted', endMs: 16000, bytes: 999 },
        ],
      },
    });
    assertEqual(short.bins[0].hostBytes, 100, 'ten-second host');
    assertEqual(short.bins[0].peerBytesBySender['peer 1'], 50, 'ten-second peer');
    assertEqual(short.bins[1].peerBytesBySender['peer 2'], 30, 'next bin');
    const input = fixture([{ condition: '13f-w-long', directory: HOUR, peer: 0.8 }]);
    input.traces.hour = {
      c03: [{ kind: 'attempt', end: 'loaded', source: 'http', endMs: 0, bytes: 100 }, {
        kind: 'attempt',
        end: 'loaded',
        source: 'p2p',
        peerId: 'private',
        endMs: 30000,
        bytes: 50,
      }],
    };
    const h = hour.data(input);
    assert(hour.takeaway(h).includes('80%'), 'published share');
    validSvg(hour, h);
    input.batches['13f'].verdicts.entries[0].figures.stallCountByClient.c03 = 1;
    throws(() => hour.data(input), 'takeaway-unsupported:hour');
    const root = path.join(app, '.scratch');
    fs.mkdirSync(root, { recursive: true });
    const temp = fs.mkdtempSync(path.join(root, 'graphs-check-'));
    try {
      const graph = path.join(app, 'scripts/measure-graphs.mjs'), out = path.join(temp, 'existing');
      fs.mkdirSync(out);
      fs.writeFileSync(path.join(out, 'sentinel'), 'unchanged');
      const existing = spawnSync(process.execPath, [graph, '--out', out], { encoding: 'utf8' });
      assertEqual(existing.status, 2, 'existing');
      assertEqual(fs.readFileSync(path.join(out, 'sentinel'), 'utf8'), 'unchanged', 'unchanged');
      const results = path.join(temp, 'results'), missingOut = path.join(temp, 'new');
      fs.mkdirSync(results);
      fs.writeFileSync(path.join(results, 'RUNS-13d.json'), '{}');
      const missing = spawnSync(process.execPath, [graph, '--out', missingOut, '--results', results], {
        encoding: 'utf8',
      });
      assertEqual(missing.status, 1, 'missing');
      assert(missing.stderr.includes('verdicts.json') && !fs.existsSync(missingOut), 'no output');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
  await check('graphs: also tested and limits remain plain', async () => {
    // Start freezes: 2 vs 4 seconds; jump freezes: 1 vs 3 seconds, one pair each.
    const pair = {
      valid: true,
      product: { start: { stalls: 2000 }, seek: { stalls: 1000 } },
      control: { start: { stalls: 4000 }, seek: { stalls: 3000 } },
    };
    const input = fixture([{
      condition: '13d-j-cut',
      directory: '13d-a-five-c03',
      readings: { 'event-clocks': { supplierCut: { stalls: { c03: { count: 0 } } } } },
    }, { condition: '13e-k-half', readings: { 'catch-up': { timeInto40Ms: 50000, resolvedBy: 'rate' } } }], {
      '13d': { E: { label: 'internal', pairs: [pair] } },
      '13e': { E10: { pairs: [] } },
    });
    const caught = input.batches['13e'].verdicts.entries[0].directory;
    input.runs[caught].manifest.disturbance = { pauseMs: 500 };
    const notes = alsoTested(input);
    assert(!BANNED.test(notes.paragraphs.join(' ')), 'plain also tested');
    assert(notes.paragraphs[0].includes('2.0') && notes.paragraphs[0].includes('4.0'), 'pair medians');
    const statements = limits([{
      regimes: [{ regime: { viewers: 10 } }],
      bars: [{ runs: [1, 2] }, { runs: [1, 2, 3] }],
    }]);
    assert(statements[3].includes('10 viewers') && statements[4].includes('2 to 3 times'), 'drawn limits');
  });
}
