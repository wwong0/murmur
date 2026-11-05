import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { createEndLatch, endInstant, endPauseMs, isEnded } from '../../../public/lib/title-end.mjs';

const DURATION = 5_000;
const START_AT = 1_000;
const END_AT = START_AT + DURATION;
const json = (value) => JSON.stringify(value);

function roster(ids, host = null) {
  return ids.map((clientId, index) => ({
    clientId,
    tabId: clientId,
    role: clientId === host ? 'host' : 'viewer',
    joinedAt: index + 1,
  }));
}

function operation(page, seq, from, payload) {
  page.deliver({ type: 'playback-operation', seq, from, ts: { recv: END_AT + 1 }, payload });
}

function createPage(product, { id, ids = ['host', 'viewer'], host = null, mode = 'open', current }) {
  const members = roster(ids, host);
  const page = runEntry(product.code, {
    role: id === host ? 'host' : 'viewer',
    search: `?room=end-room&role=${id === host ? 'host' : 'viewer'}&tab=${id}`,
    settings: { delivery: 'host', trackerUrl: 'ws://tracker.test:1', iceServers: [], autoStart: false },
  });
  page.harness.clientId = id;
  page.harness.role = id === host ? 'host' : 'viewer';
  page.harness.roster = members;
  page.emit('joined', { clientId: id, role: page.harness.role, seq: 1, roster: members });
  operation(page, 2, host ?? ids[0], {
    kind: 'create',
    lineage: 'end-lineage',
    current: current ?? { playing: true, atSharedMs: START_AT, mediaMs: 0 },
    previous: null,
    controlMode: mode,
  });
  page.harness.last = { mediaEndMs: DURATION };
  return page;
}

function endOperations(page) {
  return page.sent().filter((entry) => entry.payload?.kind === 'pause');
}

export default async function titleEndSuite() {
  const product = await bundleProductEntry();

  await check('E1 E6 title-end: end instant and ended state follow the room mapping', async () => {
    const playing = { current: { playing: true, atSharedMs: 2_000, mediaMs: 1_000 } };
    assertEqual(endInstant(playing, 7_000), 8_000, 'a playing mapping reaches the duration at its timeline instant');
    assertEqual(endInstant({ current: { playing: false, atSharedMs: 2_000, mediaMs: 1_000 } }, 7_000), null, 'a paused mapping has no end instant');
    assertEqual(endInstant({ current: { playing: true, atSharedMs: 2_000, mediaMs: 1_000 } }, null), null, 'a missing duration has no end instant');
    assertEqual(endInstant({ current: { playing: true, atSharedMs: 8_000, mediaMs: 9_000 } }, 1_000), 8_000, 'an end instant never precedes the mapping instant');
    assert(isEnded({ current: { playing: false, mediaMs: 6_999 } }, 7_000), 'one millisecond before the duration is ended');
    assert(!isEnded({ current: { playing: false, mediaMs: 6_998 } }, 7_000), 'two milliseconds before the duration is not ended');
    assert(!isEnded({ current: { playing: false, mediaMs: 7_000, held: true } }, 7_000), 'a held mapping is not ended');
    const latch = createEndLatch();
    assert(latch.take({ lineage: 'l', version: 1 }), 'the first identity is accepted');
    assert(!latch.take({ lineage: 'l', version: 1 }), 'the same identity is accepted once');
    assert(latch.take({ lineage: 'l', version: 2 }), 'a new version is accepted');
  });

  // A 14.016 s element over a 14 000 ms playlist parked at 14 000 never ended.
  await check('E9 title-end: the end pause names the element\'s own end, and Ended reads the playlist\'s', async () => {
    assertEqual(endPauseMs(14_000, 14.016), 14_017, 'an element past the playlist ends the room one millisecond past its own end');
    assertEqual(endPauseMs(14_000, 13.99), 14_000, 'an element short of the playlist keeps the playlist end');
    assertEqual(endPauseMs(14_000, Number.NaN), 14_000, 'an unknown element duration keeps the playlist end');
    assertEqual(endPauseMs(null, 14.016), null, 'no playlist end, no end pause');
    const page = createPage(product, { id: 'tail', ids: ['tail', 'other'] });
    Object.defineProperty(page.video, 'duration', { value: (DURATION + 16) / 1000, configurable: true });
    page.harness.sharedNowMs = END_AT + 1;
    page.tick();
    assertEqual(endOperations(page).length, 0, 'the playlist end alone issues no pause while the element plays on');
    page.harness.sharedNowMs = END_AT + 17;
    page.tick();
    const [pause] = endOperations(page);
    assertEqual(pause?.payload.atSharedMs, END_AT + 17, 'the end pause names the instant of the element end plus one millisecond');
    operation(page, 3, 'tail', pause.payload);
    assertEqual(page.app.playbackState().positionMs, DURATION + 17, 'the room holds that position');
    page.tick();
    assertEqual(page.view().ended, true, 'Ended reads the playlist end, so every member agrees');
    assertEqual(page.view().controls.play.text, 'Watch again', 'Watch again follows');
  });

  await check('E2 title-end: three open members converge on one end pause', async () => {
    const pages = ['a', 'b', 'c'].map((id) => createPage(product, { id, ids: ['a', 'b', 'c'] }));
    for (const page of pages) {
      page.harness.sharedNowMs = END_AT + 1;
      page.tick();
      assertEqual(endOperations(page).length, 1, `${page.harness.clientId} issues one end pause`);
    }
    const pauses = pages.flatMap((page) => endOperations(page));
    pages.forEach((page) => pauses.forEach((pause, index) => operation(page, 3 + index, pause.from ?? ['a', 'b', 'c'][index], pause.payload)));
    for (const page of pages) {
      assertEqual(json(page.app.playbackState()), json({ lineage: 'end-lineage', version: 3, playing: false, positionMs: DURATION, atSharedMs: END_AT, held: false }), `${page.harness.clientId} holds the duration with one identity`);
      assertEqual(page.app.timeline().rejected.stale, 2, `${page.harness.clientId} counts the two stale end pauses`);
    }
  });

  await check('E3 title-end: host control accepts the host pause and rejects viewer pauses', async () => {
    const ids = ['host', 'v1', 'v2'];
    const pages = ids.map((id) => createPage(product, { id, ids, host: 'host', mode: 'host' }));
    for (const page of pages) {
      page.harness.sharedNowMs = END_AT + 1;
      page.tick();
    }
    const pauses = pages.flatMap((page) => endOperations(page));
    const hostPause = pauses.find((pause) => pause.payload && pause.payload.basis);
    const viewerPauses = pauses.filter((pause) => pause !== hostPause);
    pages.forEach((page) => {
      viewerPauses.forEach((pause, index) => operation(page, 3 + index, ['v1', 'v2'][index], pause.payload));
      operation(page, 5, 'host', hostPause.payload);
    });
    for (const page of pages) {
      assertEqual(page.app.playbackState().playing, false, `${page.harness.clientId} sees the host's pause`);
      assertEqual(page.app.timeline().rejected.notPermitted, 2, `${page.harness.clientId} counts viewer end pauses as not permitted`);
    }
  });

  await check('E4 title-end: a paused room 5 s before the end issues nothing over 10 s of ticks', async () => {
    const page = createPage(product, { id: 'paused', ids: ['paused', 'other'], current: { playing: false, atSharedMs: START_AT, mediaMs: DURATION - 5_000 } });
    // 10 000 ms of 250 ms ticks: a playing mapping from here would reach the end at 5 000 ms.
    for (let elapsed = 0; elapsed <= 10_000; elapsed += 250) {
      page.harness.sharedNowMs = START_AT + elapsed;
      page.tick();
    }
    assertEqual(endOperations(page).length, 0, 'a paused room does not issue an end pause');
  });

  await check('E5 title-end: one identity latches its end pause', async () => {
    const page = createPage(product, { id: 'latch', ids: ['latch', 'other'] });
    page.harness.sharedNowMs = END_AT + 10_000;
    for (let index = 0; index < 10; index += 1) page.tick();
    assertEqual(endOperations(page).length, 1, 'ten ticks issue one end pause');
  });

  await check('E7 title-end: ended control watches again by seeking to zero, unheld, with a tracker', async () => {
    const page = createPage(product, { id: 'again', ids: ['again', 'other'], host: 'again', current: { playing: false, atSharedMs: START_AT, mediaMs: DURATION } });
    // The tracker settings must land, so the seek's hold rule sees peer exchange.
    await page.settled();
    page.harness.sharedNowMs = END_AT + 1;
    page.tick();
    assertEqual(page.view().ended, true, 'the view marks the title ended');
    assertEqual(page.view().controls.play.text, 'Watch again', 'the play control is relabelled');
    assertEqual(page.view().controls.play.disabled, false, 'watch again is enabled when seek is permitted');
    page.click('play');
    const seek = page.sent().find((entry) => entry.payload?.kind === 'seek');
    assertEqual(seek.payload.positionMs, 0, 'watch again seeks to zero');
    assert(!Object.hasOwn(seek.payload, 'hold'), 'watch again does not hold a paused unheld room');
  });

  await check('E8 title-end: a rejected end pause adds no notice', async () => {
    const page = createPage(product, { id: 'self', ids: ['self', 'other'] });
    page.harness.sharedNowMs = END_AT + 1;
    page.tick();
    const own = endOperations(page)[0];
    operation(page, 3, 'other', { ...own.payload, basis: { ...own.payload.basis } });
    operation(page, 4, 'self', own.payload);
    assert(!page.notices().some((text) => text.includes('your pause was rejected')), 'the own rejected end pause has no notice');
  });
}
