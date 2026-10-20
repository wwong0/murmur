import { assert, assertEqual, check } from '../harness.mjs';
import { viewerWaitCard } from '../../../public/lib/viewer-wait-card.mjs';

// N1's pattern: no viewer-visible text may carry it (room-continuity-steps.mjs).
const FORBIDDEN = /refused|audio|codec|aac|mp4a|refuse-audio-codec/i;

export default async function viewerWaitCardSuite() {
  await check('viewer-wait-card: each waiting state gives its words and no other state gives a card', async () => {
    assertEqual(viewerWaitCard({ state: 'choosing', fraction: null }).title, 'The host is choosing a video', 'choosing');
    const absent = viewerWaitCard({ state: 'absent', fraction: null });
    assertEqual(absent.title, 'The host has left', 'absent title');
    assertEqual(absent.note, "The room pauses until they're back", 'absent second line');
    assertEqual(viewerWaitCard({ state: 'choosing', fraction: null }).note, null, 'choosing has no second line');
    for (const state of ['ready', 'unknown', 'not-a-state', undefined]) {
      assertEqual(viewerWaitCard({ state, fraction: 0.5 }), null, `${state} has nothing to wait for`);
    }
    assertEqual(viewerWaitCard(), null, 'no status at all');
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
  });
}
