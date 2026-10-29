import { assert, assertEqual, check } from '../harness.mjs';
import { graceSecondsLeft, viewerLayer, viewerWaitCard } from '../../../public/lib/viewer-wait-card.mjs';

// N1's pattern: no viewer-visible text may carry it (room-continuity-steps.mjs).
const FORBIDDEN = /refused|audio|codec|aac|mp4a|refuse-audio-codec/i;
const DURING_GRACE = { hostStatus: { state: 'absent' }, hostSide: false, ended: false, connection: 'open', playing: true, graceLeftS: 7 };
const PILL_CASES = [
  [10, 'The host has left · pausing in 10 s'],
  [1, 'The host has left · pausing in 1 s'],
  [0, 'The host has left · pausing now'],
  [null, 'The host has left · pausing soon'],
  [undefined, 'The host has left · pausing soon'],
  [Number.NaN, 'The host has left · pausing soon'],
  [-3, 'The host has left · pausing now'],
  [2.2, 'The host has left · pausing in 3 s'],
];

export default async function viewerWaitCardSuite() {
  await check('viewer-wait-card: each waiting state gives its words and no other state gives a card', async () => {
    assertEqual(viewerWaitCard({ state: 'choosing', fraction: null }).title, 'The host is choosing a video', 'choosing');
    const absent = viewerWaitCard({ state: 'absent', fraction: null });
    assertEqual(absent.title, 'The host has left', 'absent title');
    assertEqual(absent.note, "The room is paused until they're back", 'absent second line');
    assertEqual(viewerWaitCard({ state: 'choosing', fraction: null }).note, null, 'choosing has no second line');
    for (const state of ['ready', 'unknown', 'not-a-state', undefined]) {
      assertEqual(viewerWaitCard({ state, fraction: 0.5 }), null, `${state} has nothing to wait for`);
    }
    assertEqual(viewerWaitCard(), null, 'no status at all');
  });

  await check('viewer-wait-card: grace pill wording', async () => {
    for (const [graceLeftS, expected] of PILL_CASES) {
      assertEqual(viewerLayer({ ...DURING_GRACE, graceLeftS }).pill, expected, `grace ${graceLeftS}`);
    }
  });

  await check('viewer-wait-card: shared grace time rounds up and clamps', async () => {
    for (const [end, now, expected] of [
      [10000, 0, 10], [10000, 1, 10], [10000, 9000, 1], [10000, 9001, 1],
      [10000, 10000, 0], [10000, 12000, 0], [null, 0, null],
      [10000, Number.NaN, null], [undefined, 5, null],
    ]) {
      assertEqual(graceSecondsLeft(end, now), expected, `end ${end}, now ${now}`);
    }
  });

  await check('viewer-wait-card: playing grace and paused room select their layers', async () => {
    const playing = viewerLayer(DURING_GRACE);
    assertEqual(playing.card, null, 'playing has no card');
    assertEqual(playing.pill, 'The host has left · pausing in 7 s', 'playing pill');
    const paused = viewerLayer({ ...DURING_GRACE, playing: false });
    assertEqual(paused.pill, null, 'paused has no pill');
    assertEqual(paused.card?.title, 'The host has left', 'paused title');
    assertEqual(paused.card?.note, "The room is paused until they're back", 'paused note');
  });

  await check('viewer-wait-card: layer exclusions', async () => {
    for (const [change, expectedCard, expectedPill] of [
      [{ hostSide: true }, null, null],
      [{ ended: true }, null, null],
      [{ connection: 'reconnecting' }, null, null],
      [{ playing: 'true' }, 'absent', null],
      [{ hostStatus: { state: 'ready' } }, null, null],
      [{ hostStatus: { state: 'choosing' } }, 'choosing', null],
    ]) {
      const layer = viewerLayer({ ...DURING_GRACE, ...change });
      assertEqual(layer.card?.state ?? null, expectedCard, `card for ${JSON.stringify(change)}`);
      assertEqual(layer.pill, expectedPill, `pill for ${JSON.stringify(change)}`);
    }
    for (const layer of [viewerLayer(), viewerLayer({})]) {
      assertEqual(layer.card, null, 'no status card');
      assertEqual(layer.pill, null, 'no status pill');
    }
  });

  await check('viewer-wait-card: preparing shows the floored percent, and none while no fraction has arrived', async () => {
    assertEqual(viewerWaitCard({ state: 'preparing', fraction: 0.429 }).title, 'The host is preparing the video · 42%', 'floored, not rounded');
    assertEqual(viewerWaitCard({ state: 'preparing', fraction: 0.429 }).percent, 42, 'the bar reads the same figure');
    assertEqual(viewerWaitCard({ state: 'preparing', fraction: 0 }).title, 'The host is preparing the video · 0%', 'zero is a figure');
    assertEqual(viewerWaitCard({ state: 'preparing', fraction: 1 }).percent, 100, 'full');
    for (const fraction of [null, undefined, Number.NaN]) {
      const card = viewerWaitCard({ state: 'preparing', fraction });
      assertEqual(card.title, 'The host is preparing the video', `${fraction} omits the figure`);
      assertEqual(card.percent, null, `${fraction} has no percent`);
    }
    assertEqual(viewerWaitCard({ state: 'preparing', fraction: 1.7 }).percent, 100, 'a figure past the end stays on the bar');
    assertEqual(viewerWaitCard({ state: 'preparing', fraction: -0.2 }).percent, 0, 'a figure before the start stays on the bar');
  });

  await check('viewer-wait-card: no card text matches the viewer-visible forbidden pattern', async () => {
    const cards = ['choosing', 'absent', 'preparing'].flatMap((state) => [null, 0, 0.5, 1].map((fraction) => viewerWaitCard({ state, fraction })));
    assert(cards.length > 0 && cards.every((card) => card !== null), 'every waiting state was read');
    for (const card of cards) {
      assert(!FORBIDDEN.test(card.title), `title "${card.title}"`);
      assert(card.note === null || !FORBIDDEN.test(card.note), `note "${card.note}"`);
    }
    for (const [graceLeftS] of PILL_CASES) {
      const pill = viewerLayer({ ...DURING_GRACE, graceLeftS }).pill;
      assert(pill !== null && !FORBIDDEN.test(pill), `pill "${pill}"`);
    }
  });
}
