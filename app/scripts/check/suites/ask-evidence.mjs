// 9b design.md D7: the host asks are drained by cursor and their loss is
// recorded per viewer; the host's response counts are read at both boundaries.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, assertEqual, check } from '../harness.mjs';
import { askExpression, askFile, createAskEvidence, recordHostStats } from '../../harness/ask-evidence.mjs';
import { readEdgeEvidence } from '../../figures/edge-publication.mjs';

const ask = (seq) => ({ seq, index: seq, path: `/media/seg-${String(seq).padStart(5, '0')}.m4s`, startMs: seq * 4_000, reason: 'first', rank: 0, atMs: 9_000 + seq });

// A page holding `ring`, answering hostAsks(cursor) as the product does, on a wall clock 5 000 ms ahead of the harness's.
function world(ring, { evicted = 0, latestSeq = ring.at(-1)?.seq ?? 0 } = {}) {
  let t = 1_000;
  const files = {};
  const asked = [];
  const session = { tag: 'c01', tab: { evaluate: async (source) => {
    asked.push(source);
    const cursor = Number(source.match(/hostAsks\((\d+)\)/)[1]);
    t += 4;
    return { asks: { records: ring.filter((record) => record.seq > cursor), evicted, latestSeq }, wallMs: t - 2 + 5_000 };
  } } };
  const ndjson = { append: (name, records) => { (files[name] ??= []).push(...records); } };
  return { session, files, asked, ring, advance: (ms) => { t += ms; }, now: () => t, ndjson };
}

async function thrownBy(run) {
  try { await run(); } catch (error) { return error; }
  return null;
}

export default async function askEvidenceSuite() {
  await check('ask evidence: asks are drained by cursor, once a second, with the read\'s bracket', async () => {
    const fake = world([ask(1), ask(2)]);
    const evidence = createAskEvidence({ ndjson: fake.ndjson, now: fake.now });
    assertEqual(await evidence.drain(fake.session), 2, 'the first read takes both asks');
    assertEqual(fake.asked[0], askExpression(0), 'from cursor 0');
    fake.advance(500);
    assertEqual(await evidence.drain(fake.session), null, 'a read 500 ms later is not made');
    fake.ring.push(ask(3));
    fake.advance(500);
    assertEqual(await evidence.drain(fake.session), 1, 'one 1 000 ms later takes the new ask only');
    assertEqual(fake.asked[1], askExpression(2), 'from cursor 2');
    const kept = fake.files[askFile('c01')];
    assertEqual(kept.map((record) => record.seq).join(','), '1,2,3', 'the file holds each ask once');
    assertEqual(`${kept[0].harnessBeforeMs}/${kept[0].harnessAfterMs}`, '1000/1004', 'with the harness instants around its read');
    const health = evidence.health().c01;
    assertEqual(`${health.received}/${health.latestSeq}/${health.evicted}/${health.gaps}/${health.reads}`, '3/3/0/0/2', 'three received, none lost, in two reads');
    assertEqual(health.wallOffsetMs, 5_000, 'the page\'s wall clock is 5 000 ms ahead of the harness\'s');
    assertEqual(health.maxBracketMs, 4, 'and the widest read took 4 ms');
  });

  await check('ask evidence: eviction and a seq gap are recorded for the viewer', async () => {
    const evicted = world([ask(4), ask(5)], { evicted: 3 });
    const first = createAskEvidence({ ndjson: evicted.ndjson, now: evicted.now });
    await first.drain(evicted.session);
    assertEqual(`${first.health().c01.evicted}/${first.health().c01.gaps}`, '3/1', 'three evicted, and the gap before seq 4');
    const behind = world([ask(1)], { latestSeq: 2 });
    const second = createAskEvidence({ ndjson: behind.ndjson, now: behind.now });
    await second.drain(behind.session);
    assertEqual(second.health().c01.gaps, 1, 'a page that holds more than it returned lost the difference');
    const whole = world([ask(1), ask(2)]);
    const third = createAskEvidence({ ndjson: whole.ndjson, now: whole.now });
    await third.drain(whole.session);
    assertEqual(`${third.health().c01.evicted}/${third.health().c01.gaps}`, '0/0', 'a whole record has neither');
    const malformed = createAskEvidence({ ndjson: whole.ndjson, now: whole.now });
    const error = await thrownBy(() => malformed.drain({ tag: 'c02', tab: { evaluate: async () => ({ asks: { records: null }, wallMs: 1 }) } }));
    assertEqual(error?.message, 'host ask reading is malformed: c02', 'a reading whose records are not an array is a hard error');
  });

  await check('ask evidence: the health file and the ask files are read back for the figures', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-evidence-'));
    try {
      const fake = world([ask(1), ask(2)]);
      const ndjson = { append: (name, records) => fs.appendFileSync(path.join(runDir, name), records.map((record) => `${JSON.stringify(record)}\n`).join('')) };
      const evidence = createAskEvidence({ ndjson, runDir, now: fake.now });
      await evidence.drain(fake.session);
      evidence.finalize();
      const stats = { protocolErrors: 0, responses: 12, urgentResponses: 3, nearResponses: 4, channels: 5 };
      const kept = await recordHostStats({ kind: 'start', hostSession: { tab: { evaluate: async () => stats } }, runDir, now: () => 77 });
      assertEqual(JSON.stringify(kept), JSON.stringify({ ...stats, atMs: 77 }), 'the host\'s response counts with the instant read');
      const read = readEdgeEvidence(runDir, ['c01', 'c02']);
      assertEqual(read.asksByClient.c01.records.length, 2, 'c01\'s two asks');
      assertEqual(read.asksByClient.c01.wallOffsetMs, 5_000, 'with its wall offset');
      assertEqual(read.asksByClient.c02, null, 'a viewer with no health entry has no ask evidence, not an empty one');
      assertEqual(read.hostStats.start.responses, 12, 'the start boundary\'s counts');
      assertEqual(read.hostStats.end, null, 'and no end boundary until it is read');
      const absent = await thrownBy(() => recordHostStats({ kind: 'end', hostSession: { tab: { evaluate: async () => null } }, runDir }));
      assert(absent?.message.startsWith('host stats are unavailable at the end boundary'), 'a null on the host\'s page is a hard error');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
}
