// 9b design.md D1 (J6): the link qualification's fetch is issued when the first
// viewer's link opens, collected after the joins, and a fault after 180 s.

import { assert, assertEqual, check } from '../harness.mjs';
import {
  beginLinkQualification, finishLinkQualification, hostEstimateNear, QUALIFICATION_FETCH_TIMEOUT,
} from '../../harness/qualification.mjs';
import { armFor } from '../../harness/arms.mjs';

const SEGMENT_BYTES = 1_100_000;
const WALL_OFFSET_MS = 5_000_000;
const FAKE_CLOCK_LIMIT_MS = 400_000;

// One fake clock, a viewer whose fetch settles `resolveAfterMs` after it was
// issued (never, when null), and a host that recorded the same response.
function world({ resolveAfterMs }) {
  let t = 0;
  let issuedAt = null;
  const now = () => t;
  const pause = async (ms) => {
    t += ms;
    if (t > FAKE_CLOCK_LIMIT_MS) throw new Error(`fake clock ran past ${FAKE_CLOCK_LIMIT_MS} ms`);
  };
  const done = () => issuedAt !== null && resolveAfterMs !== null && t >= issuedAt + resolveAfterMs;
  const viewerTab = {
    evaluate: async (source) => {
      if (source.includes('fetch(')) { issuedAt = t; return t + WALL_OFFSET_MS; }
      if (source.includes('__waLinkQualification')) {
        return done()
          ? { done: true, bytes: SEGMENT_BYTES, error: null, completedWallMs: issuedAt + resolveAfterMs + WALL_OFFSET_MS }
          : { done: false, bytes: null, error: null, completedWallMs: null };
      }
      if (source.includes('hostReceipts')) {
        return { records: [{ url: '/media/seg-01500.m4s', bodyBytes: SEGMENT_BYTES, finished: true, originResponseId: 'r1' }] };
      }
      if (source.includes('hostLink')) return { state: 'open' };
      throw new Error(`unexpected viewer evaluate: ${source}`);
    },
  };
  const hostTab = {
    evaluate: async () => ({ counters: { responseRecords: [{ originResponseId: 'r1', delivered: SEGMENT_BYTES, aborted: false }] } }),
  };
  const options = { originContainer: 'origin', now, pause, exec: () => `${SEGMENT_BYTES}\n` };
  return { now, pause, viewerTab, hostTab, options, done };
}

async function thrownBy(run) {
  try { await run(); } catch (error) { return error; }
  return null;
}

export default async function qualificationEarlySuite() {
  await check('qualification early: begin returns before the fetch resolves, and finish reads the four-way agreement', async () => {
    const fake = world({ resolveAfterMs: 1_000 });
    const handle = await beginLinkQualification(fake.viewerTab, { segmentSeconds: 4, now: fake.now, pause: fake.pause });
    assertEqual(fake.now(), 0, 'begin took no time on the fake clock');
    assertEqual(fake.done(), false, 'the fetch has not resolved when begin returns');
    assertEqual(handle.fetchIssuedAtMs, 0, 'the fetch was issued at 0 ms');
    const record = await finishLinkQualification(handle, fake.hostTab, fake.options);
    assertEqual(record.status, 'passed', 'the four byte counts agree');
    assertEqual(record.fetchedBytes, 1_100_000, 'the fetched bytes are the page\'s');
    assertEqual(record.instants.beginAtMs, 0, 'begin instant');
    assertEqual(record.instants.fetchCompletedAtMs, 1_000, 'the completion instant is placed on the harness clock');
    assertEqual(record.instants.finishAtMs, 1_000, 'finish returned at the poll that saw the body');
  });

  await check('qualification early: a fetch not complete 180 s after it was issued is a runner fault', async () => {
    // The pair differs only in when the fetch resolves: 179 900 ms and never.
    const inside = world({ resolveAfterMs: 179_900 });
    const insideRecord = await finishLinkQualification(
      await beginLinkQualification(inside.viewerTab, { segmentSeconds: 4, now: inside.now, pause: inside.pause }), inside.hostTab, inside.options);
    assertEqual(insideRecord.status, 'passed', 'a body complete at 179 900 ms qualifies');
    const starved = world({ resolveAfterMs: null });
    const handle = await beginLinkQualification(starved.viewerTab, { segmentSeconds: 4, now: starved.now, pause: starved.pause });
    const error = await thrownBy(() => finishLinkQualification(handle, starved.hostTab, starved.options));
    assertEqual(error?.code, QUALIFICATION_FETCH_TIMEOUT, 'a starved fetch throws qualification-fetch-timeout');
    assertEqual(error.elapsedMs, 180_000, 'with the elapsed time');
    assertEqual(starved.now(), 180_000, 'at 180 000 ms of the fake clock');
    // Prevention claim: a starved qualification fetch cannot hold a run past 180 s.
    // Opportunity: the fetch never resolves. Action boundary: finish's wait for the body.
    // Mutation, with the file copied aside: the `elapsedMs >= timeoutMs` throw removed
    // from finishLinkQualification. `npm run check` turned 'a starved fetch throws
    // qualification-fetch-timeout' red (got undefined: the fake clock ran past
    // 400 000 ms). Restored from the copy, diff empty; green again.
  });

  await check('qualification early: the timeout leaves the arm as a fault, and any other error as a failed record', async () => {
    const arm = armFor({ delivery: 'host' });
    const sessions = [{ tab: {} }];
    const context = { originSession: { tab: {} }, originContainer: 'origin', pending: Promise.resolve({}) };
    const timeout = Object.assign(new Error('qualification-fetch-timeout: late'), { code: QUALIFICATION_FETCH_TIMEOUT });
    const fault = await thrownBy(() => arm.qualify(sessions, { ...context, finishLinkQualification: async () => { throw timeout; } }));
    assertEqual(fault, timeout, 'the timeout is thrown out of the arm');
    const failed = await arm.qualify(sessions, { ...context, finishLinkQualification: async () => { throw new Error('receipt missing'); } });
    assertEqual(failed.status, 'failed', 'another error is a failed qualification');
    assertEqual(failed.reason, 'qualification-error:receipt missing', 'naming it');
    // Prevention claim: a qualification timeout cannot be recorded as a refusal.
    // Opportunity: finish throws the timeout inside the arm's catch. Action boundary:
    // qualifyWith. Mutation, with arms.mjs copied aside: the rethrow on
    // QUALIFICATION_FETCH_TIMEOUT removed. `npm run check` turned 'the timeout is
    // thrown out of the arm' red (got null). Restored from the copy, diff empty; green.
  });

  await check('qualification early: the host poll nearest the completion says whether the host had an estimate', async () => {
    const readings = [{ atMs: 900, bytesPerSecond: null }, { atMs: 1_150, bytesPerSecond: 1_000_000 }];
    const before = hostEstimateNear(readings, 1_000);
    assertEqual(before.pollAtMs, 900, 'the poll 100 ms before is nearer than the one 150 ms after');
    assertEqual(before.hadEstimate, false, 'a null estimate is no estimate');
    const after = hostEstimateNear(readings, 1_100);
    assertEqual(after.pollAtMs, 1_150, 'the poll 50 ms after is nearer');
    assertEqual(after.hadEstimate, true, 'a positive estimate is one');
    assert(hostEstimateNear([], 1_000) === null, 'no polls, no reading');
  });
}
