import { assert, assertEqual, check } from '../harness.mjs';
import { createPageView } from '../../../public/lib/page-view.mjs';

export default async function pageViewSuite() {
  await check('page-view: initial get returns the supplied snapshot', async () => {
    const initial = { status: 'unknown' };
    const view = createPageView(initial);
    assertEqual(view.get(), initial, 'initial snapshot');
  });

  await check('page-view: get keeps identity until a set', async () => {
    const view = createPageView({ status: 'unknown' });
    assert(view.get() === view.get(), 'unchanged snapshot identity');
  });

  await check('page-view: set replaces one key and publishes it', async () => {
    const view = createPageView({ status: 'unknown', count: 1 });
    const calls = [];
    view.subscribe((key, snapshot) => calls.push([key, snapshot]));
    view.set('status', 'ready');
    assertEqual(view.get().count, 1, 'other key survives');
    assertEqual(view.get().status, 'ready', 'set key');
    assertEqual(calls.length, 1, 'one notification');
    assertEqual(calls[0][0], 'status', 'published key');
    assert(calls[0][1] === view.get(), 'published snapshot is current');
  });

  await check('page-view: unknown keys throw without changing the snapshot', async () => {
    const view = createPageView({ status: 'unknown' });
    const before = view.get();
    let error;
    try { view.set('missing', true); } catch (caught) { error = caught; }
    assert(error instanceof TypeError, 'unknown key TypeError');
    assert(view.get() === before, 'unknown key leaves snapshot identity');
  });

  await check('page-view: subscriber errors report and do not stop delivery', async () => {
    const errors = [];
    const seen = [];
    const view = createPageView({ status: 'unknown' }, { onError: (error, key) => errors.push([error, key]) });
    view.subscribe(() => seen.push('first'));
    const failure = new Error('subscriber failed');
    view.subscribe(() => { throw failure; });
    view.subscribe(() => seen.push('third'));
    view.set('status', 'ready');
    assertEqual(seen.join(','), 'first,third', 'remaining subscribers run');
    assertEqual(errors.length, 1, 'the error is reported once');
    assert(errors[0][0] === failure && errors[0][1] === 'status', 'subscriber error is reported');
  });

  await check('page-view: unsubscribe also removes during a notification', async () => {
    const view = createPageView({ status: 'unknown' });
    const seen = [];
    let offThird;
    view.subscribe(() => { seen.push('first'); offThird(); });
    view.subscribe(() => seen.push('second'));
    offThird = view.subscribe(() => seen.push('third'));
    view.set('status', 'ready');
    assertEqual(seen.join(','), 'first,second', 'removed subscriber is skipped');
    view.set('status', 'done');
    assertEqual(seen.join(','), 'first,second,first,second', 'unsubscribed subscriber stays absent');
  });

  await check('page-view: equal values still notify', async () => {
    const view = createPageView({ status: 'unknown' });
    let calls = 0;
    view.subscribe(() => { calls += 1; });
    view.set('status', 'ready');
    view.set('status', 'ready');
    assertEqual(calls, 2, 'same value publishes twice');
  });

  await check('page-view: nested sets deliver current snapshots', async () => {
    const view = createPageView({ status: 'unknown', count: 0 });
    const rounds = [];
    let nested = false;
    view.subscribe((key, snapshot) => {
      rounds.push([key, snapshot.status, snapshot.count, view.get() === snapshot]);
      if (!nested) {
        nested = true;
        view.set('count', 1);
      }
    });
    view.set('status', 'ready');
    assertEqual(JSON.stringify(rounds), JSON.stringify([
      ['status', 'ready', 0, true],
      ['count', 'ready', 1, true],
    ]), 'nested rounds and latest snapshot');
  });
}
