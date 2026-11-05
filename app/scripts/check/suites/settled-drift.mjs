// The settled-drift reader, hand-computed on a zero-offset timebase.

import { assert, assertEqual, check } from '../harness.mjs';
import { decideFinalization } from '../../harness-run.mjs';
import { computeHarnessFigureKinds } from '../../figures/harness-figures.mjs';
import { settledDrift } from '../../figures/settled-drift.mjs';

const timebase = { offsetMs: 0 };
const START_MS = 100_000;
const END_MS = 280_000;
const BAD_AT_MS = 210_000;

function pollsFor({ settleAtMs = 120_000, skipFromMs = Infinity, endMs = END_MS } = {}) {
  const polls = [];
  for (let at = START_MS; at <= endMs; at += 1000) {
    polls.push({ atMs: at, clock: { offsetMs: 0 }, controller: { mode: at < settleAtMs ? 'waiting' : 'settled' },
      playback: { skips: at >= skipFromMs ? 1 : 0 } });
  }
  return polls;
}

// One record per 100 ms; `dropFrom`..`dropTo` leaves a hole without breaking the sequence.
function recordsFor({ badFromMs = BAD_AT_MS, badToMs = BAD_AT_MS + 1000, driftMs = 55, dropFrom = Infinity, dropTo = -Infinity,
  endMs = END_MS } = {}) {
  const records = [];
  for (let at = START_MS; at <= endMs; at += 100) {
    if (at >= dropFrom && at <= dropTo) continue;
    const seq = records.length;
    records.push({ seq, presentedFrames: seq + 1, displaySharedMs: at, driftMs: at >= badFromMs && at < badToMs ? driftMs : 0 });
  }
  return records;
}

function read({ polls = pollsFor(), records = recordsFor(), endMs = END_MS, tags = ['c01'] } = {}) {
  return settledDrift({ tags, window: { startMs: START_MS, endMs }, timebase, drift: { c01: records },
    pagePolls: { c01: polls }, hostPoll: [] });
}

export default async function settledDriftSuite() {
  await check('settled-drift: a 55 ms window 90 000 ms after settling is published, with no stall and no skip', async () => {
    const reading = read();
    const client = reading.byClient.c01;
    assertEqual(client.status, 'settled', 'the viewer settled');
    assertEqual(client.settledAtSharedMs, 120_000, 'at 120 000 ms');
    assertEqual(client.settledAfterWindowStartMs, 20_000, '20 000 ms into the window');
    assertEqual(client.windowsRead, 160, '160 tiles from 120 000 to 280 000');
    assertEqual(client.windowsExceeding, 1, 'one exceeds');
    const [window] = client.windows;
    assertEqual(window.startSharedMs, 210_000, 'its start');
    assertEqual(window.afterSettledMs, 90_000, 'after settling');
    assertEqual(window.afterWindowStartMs, 110_000, 'after the window start');
    assertEqual(window.medianDriftMs, 55, 'median drift');
    assertEqual(window.records, 10, 'ten records');
    assertEqual(window.modes.join(), 'settled', 'the poll mode');
    assertEqual(window.stall, false, 'no stall');
    assertEqual(window.skip, false, 'no skip');
    assertEqual(reading.shown, true, 'shown');
    assertEqual(JSON.stringify(reading.shownBy), JSON.stringify([{ tag: 'c01', startSharedMs: 210_000 }]), 'by whom');
  });

  await check('settled-drift: a viewer that never settles has no windows, and drift is not shown', async () => {
    const reading = read({ polls: pollsFor({ settleAtMs: Infinity }) });
    assertEqual(reading.byClient.c01.status, 'never-settled', 'never settled');
    assertEqual(reading.byClient.c01.windows.length, 0, 'no windows');
    assertEqual(reading.shown, false, 'not shown');
  });

  await check('settled-drift: a 400 ms frame gap in the window is a stall and the window does not show it', async () => {
    const reading = read({ records: recordsFor({ dropFrom: 210_200, dropTo: 210_400 }) });
    const [window] = reading.byClient.c01.windows;
    assertEqual(window.medianDriftMs, 55, 'the median is unchanged');
    assertEqual(window.stall, true, 'a stall');
    assertEqual(reading.shown, false, 'not shown');
    assertEqual(reading.shownBy.length, 0, 'by no one');
    const short = read({ records: recordsFor({ dropFrom: 210_200, dropTo: 210_200 }) });
    assertEqual(short.byClient.c01.windows[0].stall, false, 'a 200 ms gap is not a stall');
    assertEqual(short.shown, true, 'and shows');
  });

  await check('settled-drift: a skip counted across the window is a skip and the window does not show it', async () => {
    const reading = read({ polls: pollsFor({ skipFromMs: 210_500 }) });
    const [window] = reading.byClient.c01.windows;
    assertEqual(window.skip, true, 'a skip');
    assertEqual(window.stall, false, 'no stall');
    assertEqual(reading.shown, false, 'not shown');
    const before = read({ polls: pollsFor({ skipFromMs: 209_500 }) });
    assertEqual(before.byClient.c01.windows[0].skip, false, 'a skip in the window before is not this window\'s');
    assertEqual(before.shown, true, 'and shows');
  });

  await check('settled-drift: a negative median is published signed', async () => {
    const reading = read({ records: recordsFor({ driftMs: -55 }) });
    assertEqual(reading.byClient.c01.windows[0].medianDriftMs, -55, 'signed');
    assertEqual(reading.shown, true, 'shown');
  });

  await check('settled-drift: exactly 40.0 does not exceed and 40.5 does', async () => {
    const at = read({ records: recordsFor({ driftMs: 40 }) });
    assertEqual(at.byClient.c01.windowsExceeding, 0, '40.0 does not exceed');
    assertEqual(at.shown, false, 'not shown');
    assertEqual(read({ records: recordsFor({ driftMs: 40.5 }) }).byClient.c01.windowsExceeding, 1, '40.5 does');
  });

  await check('settled-drift: the tiles start at the settled instant, not at the window start', async () => {
    const polls = pollsFor({ settleAtMs: 120_000 }).map((poll) => ({ ...poll, atMs: poll.atMs + 300 })).filter((poll) => poll.atMs <= END_MS);
    const reading = read({ polls, records: recordsFor({ badFromMs: 210_300, badToMs: 211_300 }) });
    const client = reading.byClient.c01;
    assertEqual(client.settledAtSharedMs, 120_300, 'settled at 120 300');
    assertEqual(client.windowsRead, 159, 'tiles of 1 000 ms from there: 159');
    assertEqual(client.windows.length, 1, 'one window exceeds');
    assertEqual(client.windows[0].startSharedMs, 210_300, 'on the settled grid, not at 210 000');
    assertEqual(client.windows[0].afterSettledMs, 90_000, 'exactly 90 000 ms after settling');
    assertEqual(client.windows[0].records, 10, 'ten records');
  });

  await check('settled-drift: the last incomplete window is not read, and a complete one is', async () => {
    const hot = recordsFor({ endMs: 280_500 }).map((record) => (record.displaySharedMs >= 280_000 ? { ...record, driftMs: 99 } : record));
    const partial = read({ records: hot, polls: pollsFor({ endMs: 280_500 }), endMs: 280_500 });
    assertEqual(partial.byClient.c01.windowsRead, 160, 'still 160 tiles');
    assertEqual(partial.byClient.c01.windowsExceeding, 1, 'the partial tail is not among those exceeding');
    const hotFull = recordsFor({ endMs: 281_000 }).map((record) => (record.displaySharedMs >= 280_000 ? { ...record, driftMs: 99 } : record));
    const full = read({ records: hotFull, polls: pollsFor({ endMs: 281_000 }), endMs: 281_000 });
    assertEqual(full.byClient.c01.windowsRead, 161, 'a 161st tile completes');
    assertEqual(full.byClient.c01.windowsExceeding, 2, 'and is read');
  });

  await check('settled-drift: a viewer with no drift stream is unreadable and shown is null', async () => {
    const reading = settledDrift({ tags: ['c01'], window: { startMs: START_MS, endMs: END_MS }, timebase, drift: {},
      pagePolls: { c01: pollsFor() }, hostPoll: [] });
    assertEqual(reading.byClient.c01.status, 'unreadable', 'unreadable');
    assertEqual(reading.byClient.c01.reason, 'drift-stream-missing', 'why');
    assertEqual(reading.shown, null, 'null');
    assertEqual(reading.shownReason, 'unreadable:c01', 'named');
    const empty = read({ polls: [] });
    assertEqual(empty.byClient.c01.reason, 'poll-window-empty', 'no polls in the window');
    const noWindow = settledDrift({ tags: ['c01'], window: {}, timebase });
    assertEqual(noWindow.reason, 'window-unavailable', 'no window');
  });

  await check('settled-drift: an exceeding window with no skip evidence is null, not false', async () => {
    const polls = pollsFor().map(({ playback, ...poll }) => poll);
    const reading = read({ polls });
    assertEqual(reading.byClient.c01.windows[0].skip, null, 'skip unknown');
    assertEqual(reading.byClient.c01.windows[0].skipEvidence, 'unavailable', 'and said so');
    assertEqual(reading.shown, null, 'shown is null');
    assertEqual(reading.shownReason, 'skip-evidence-unavailable', 'with its reason');
  });

  await check('settled-drift: the kind dispatches the reader and the publication writes it', async () => {
    const input = { condition: { figureKinds: ['settled-drift'] }, declaredClientTags: ['c01'],
      clients: { c01: { records: recordsFor(), polls: pollsFor() } }, window: { startMs: START_MS, endMs: END_MS }, timebase, hostPoll: [] };
    const recomputed = computeHarnessFigureKinds(input);
    assertEqual(recomputed.settledDrift.shown, true, 'dispatched');
    assertEqual(decideFinalization({ evaluation: {}, recomputed, figureKinds: ['byte', 'drift', 'settled-drift'] }).writeSettledDrift, true, 'written');
    assertEqual(decideFinalization({ evaluation: {}, recomputed: {}, figureKinds: ['byte', 'drift', 'settled-drift'] }).writeSettledDrift, false, 'not without the figure');
    assert(!('writeSettledDrift' in decideFinalization({ evaluation: {}, recomputed, figureKinds: ['byte'] })), 'not without the kind');
  });
}
