// T15 (design.md D2, the echo round trip): the queue signal the host's estimate
// reads, and the two ends of the echo. No server, no timer.

import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeClock, createFakeLink } from '../fake-channel.mjs';
import { createEchoDelay, ECHO_MARGIN_MS, ECHO_OUTSTANDING_MAX, ECHO_PERIOD_MS } from '../../../public/lib/echo-delay.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { parseControl } from '../../../public/lib/segment-protocol.mjs';

// One echo sent at `sentMs` on `key` and answered `roundTripMs` later.
function roundTrip(echo, key, sentMs, roundTripMs) {
  const n = echo.due(key, sentMs);
  assert(n !== null, `an echo is due on ${key} at ${sentMs}`);
  echo.answered(key, n, sentMs + roundTripMs);
}

export default async function echoDelaySuite() {
  await check('echo-delay: the numbers T15 fixed', async () => {
    assertEqual(ECHO_PERIOD_MS, 100, 'an echo every 100 ms');
    assertEqual(ECHO_MARGIN_MS, 30, 'a queue is a round trip more than 30 ms above its floor');
  });

  await check('echo-delay: an echo is due once a period, and a channel that answers nothing stops at its cap', async () => {
    const echo = createEchoDelay();
    echo.add('a');
    assertEqual(echo.due('a', 0), 1, 'the first echo is due at once');
    assertEqual(echo.due('a', 99), null, 'none inside the period');
    assertEqual(echo.due('a', 100), 2, 'the next at the period');
    assertEqual(echo.due('b', 100), null, 'none on a channel never added');
    let sent = 2;
    for (let at = 200; at < 100 * (ECHO_OUTSTANDING_MAX + 10); at += 100) if (echo.due('a', at) !== null) sent += 1;
    assertEqual(sent, ECHO_OUTSTANDING_MAX, 'unanswered echoes stop at the cap');
    assertEqual(echo.closeInterval(0, 1000).queueMs, null, 'and an interval with no answer reads no queue');
  });

  await check('echo-delay: the queue is the lowest round trip above the channel\'s floor, by half and over the interval', async () => {
    const echo = createEchoDelay();
    echo.add('a');
    roundTrip(echo, 'a', 0, 4);
    roundTrip(echo, 'a', 100, 60); // a chunk in flight ahead of this one
    roundTrip(echo, 'a', 200, 4);
    roundTrip(echo, 'a', 600, 90);
    roundTrip(echo, 'a', 700, 54);
    const first = echo.closeInterval(0, 1000);
    assertEqual(first.samples, 5, 'five answers');
    assertEqual(first.headQueueMs, 0, 'the first half\'s lowest sits on the floor, the slow one filtered out');
    assertEqual(first.tailQueueMs, 50, 'the second half\'s lowest is 50 ms above it');
    assertEqual(first.queueMs, 0, 'the interval reads its lowest');
    roundTrip(echo, 'a', 1000, 44);
    const second = echo.closeInterval(1000, 2000);
    assertEqual(second.queueMs, 40, 'the floor is the channel\'s lowest ever, kept across intervals');
    assertEqual(second.tailQueueMs, null, 'a half with no answer reads null');
    // An answer counts in the interval it arrives in.
    const n = echo.due('a', 2900);
    assertEqual(echo.closeInterval(2000, 3000).samples, 0, 'an echo still out is not a sample');
    echo.answered('a', n, 3200);
    assertEqual(echo.closeInterval(3000, 4000).headQueueMs, 296, 'it is one where it is answered');
    echo.answered('a', n, 3300);
    echo.answered('a', 999, 3300);
    assertEqual(echo.closeInterval(4000, 5000).samples, 0, 'a second answer, or one to no echo, is ignored');
  });

  await check('echo-delay: the lowest channel decides, so one slow viewer is not a queue on the host\'s link', async () => {
    const echo = createEchoDelay();
    echo.add('slow');
    echo.add('fast');
    roundTrip(echo, 'slow', 0, 5);
    roundTrip(echo, 'fast', 0, 5);
    echo.closeInterval(0, 1000);
    for (const at of [1000, 1100, 1600, 1700]) {
      roundTrip(echo, 'slow', at, 205);
      roundTrip(echo, 'fast', at, 5);
    }
    const one = echo.closeInterval(1000, 2000);
    assertEqual(one.queueMs, 0, 'one channel on its floor: no queue below the host');
    assertEqual(one.tailQueueMs, 0, 'in either half');
    for (const at of [2000, 2100, 2600, 2700]) {
      roundTrip(echo, 'slow', at, 205);
      roundTrip(echo, 'fast', at, 85);
    }
    const both = echo.closeInterval(2000, 3000);
    assertEqual(both.queueMs, 80, 'every channel delayed: the queue is the least of them');
    assert(both.queueMs > ECHO_MARGIN_MS, 'and it is past the margin');
    echo.drop('fast');
    for (const at of [3000, 3600]) roundTrip(echo, 'slow', at, 205);
    assertEqual(echo.closeInterval(3000, 4000).queueMs, 200, 'a dropped channel no longer speaks');
    // Mutation probe, staged: closeInterval's three across-channel `lowest` calls
    // made a highest. `npm run check` turned 'one channel on its floor' red (200).
    // Reverted; check green again.
  });

  await check('echo-delay: an answer confirms the bytes handed before its echo, and an echo after a chunk times nothing', async () => {
    const echo = createEchoDelay();
    echo.add('a');
    assertEqual(echo.confirmed('none', 0, 500), null, 'a channel never added confirms nothing');
    assertEqual(echo.confirmed('a', 0, 500).totalBytes, 0, 'nothing is confirmed before an answer');
    const first = echo.due('a', 0);
    echo.handed('a', first, 100);
    echo.answered('a', first, 4);
    const chunk = echo.after('a', 10);
    assertEqual(chunk, 2, 'an echo after a chunk takes the next number');
    assertEqual(echo.due('a', 100), 3, 'and leaves the cadence where it was');
    echo.handed('a', chunk, 65_700);
    echo.handed('a', 3, 65_800);
    echo.answered('a', chunk, 300);
    const early = echo.confirmed('a', 300, 500);
    assertEqual(early.totalBytes, 65_700, 'its answer confirms every byte handed before it');
    assertEqual(early.windowBytes, 65_700, 'inside the first window, all of it');
    const interval = echo.closeInterval(0, 1000);
    assertEqual(interval.samples, 1, 'the chunk echo, 290 ms behind its chunk, is not a round-trip sample');
    assertEqual(interval.queueMs, 0, 'so the interval reads the floor');
    echo.answered('a', 3, 800);
    assertEqual(echo.confirmed('a', 800, 500).windowBytes, 100 * 500 / 500, 'a mark a full window old is the base: 100 bytes since, over its 500 ms');
    assertEqual(echo.confirmed('a', 1300, 500).windowBytes, 0, 'and with no later answer, the window is empty');
    assertEqual(echo.confirmed('a', 1300, 500).totalBytes, 65_800, 'while the total stands');
    // Mutation probe, staged: `after` marking its echo timed. `npm run check` turned
    // 'the chunk echo, 290 ms behind its chunk, is not a round-trip sample' red (2).
    // Reverted; check green again.
  });

  await check('echo-delay: the host sends its first echo before any body and one a period after, and the viewer\'s answer is the same message', async () => {
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 10_000, viewerDrainBytesPerMs: 10_000, answerEcho: false });
    const origin = createHostOrigin({ readSource: async () => ({ status: 200, bytes: new Uint8Array(1) }), clock, pace: { fraction: 0.85 } });
    const detach = origin.attach(link.host);
    try {
      const echoes = () => link.host.ledger.filter((entry) => typeof entry.data === 'string').map((entry) => parseControl(entry.data)).filter((control) => control?.t === 'echo');
      assertEqual(echoes().length, 1, 'one echo at attach');
      assertEqual(echoes()[0].n, 1, 'numbered from 1');
      clock.advance(1000);
      const sent = echoes();
      assert(sent.length >= 10 && sent.length <= 11, `one echo a period over 1 s (got ${sent.length})`);
      assertEqual(origin.pace().intervals.at(-1).echoSamples, 0, 'a viewer that answers nothing gives no sample');
      assertEqual(origin.pace().intervals.at(-1).queueMs, null, 'and the interval reads no queue');
    } finally {
      detach();
      link.closeBoth();
    }
  });
}
