import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { joinTarget, readRoute } from '../../../public/lib/route.mjs';
import { createRoomClient } from '../../../public/lib/room-client.mjs';

export default async function routeSuite() {
  const product = await bundleProductEntry();

  await check('R1 route: query parsing keeps the room role and tab', async () => {
    assertEqual(JSON.stringify(readRoute('?room=demo&role=host&tab=alpha')), JSON.stringify({ room: 'demo', role: 'host', tab: 'alpha' }), 'host route fields');
    assertEqual(JSON.stringify(readRoute('?room=demo')), JSON.stringify({ room: 'demo', role: 'viewer', tab: null }), 'viewer defaults');
    assertEqual(JSON.stringify(readRoute('')), JSON.stringify({ room: null, role: null, tab: null }), 'front route fields');
  });

  await check('R2 route: join targets accept links and safe room names', async () => {
    assertEqual(joinTarget('https://watchalong.test/room.html?room=demo'), 'demo', 'invite URL room');
    assertEqual(joinTarget('demo'), 'demo', 'bare room name');
    assertEqual(joinTarget(' name '), 'name', 'trimmed room name');
    assertEqual(joinTarget(''), null, 'empty input');
    assertEqual(joinTarget('a b'), null, 'whitespace in a room name');
    assertEqual(joinTarget('https://watchalong.test/invite'), null, 'URL without room');
  });

  await check('R3 route: a room-less entry stays on the front page', async () => {
    const page = runEntry(product.code, { search: '' });
    await page.settled();
    assertEqual(page.view().route, 'front', 'the initial route is front');
    assertEqual(page.app.room, null, 'the front page has no room');
    assertEqual(page.history.replacements.length, 0, 'the front page does not rewrite its URL');
    assertEqual(page.count('connect'), 0, 'the front page does not connect');
    assertEqual(page.fetches.filter((resource) => resource === '/app-settings').length, 0, 'the front page does not start the app');
  });

  await check('R4 route: Host creates one room and starts it once', async () => {
    const page = runEntry(product.code, { search: '' });
    page.screens().actions.host();
    await page.settled();
    assertEqual(page.view().route, 'room', 'Host enters the room route');
    assert(typeof page.app.room === 'string' && page.app.room.length > 0, 'Host creates a room');
    assertEqual(page.history.replacements.length, 1, 'Host rewrites the URL once');
    assertEqual(page.count('connect'), 1, 'Host connects once');
    assertEqual(page.fetches.filter((resource) => resource === '/app-settings').length, 1, 'Host starts the app once');
    page.screens().actions.host();
    await page.settled();
    assertEqual(page.history.replacements.length, 1, 'a second Host does nothing');
    assertEqual(page.count('connect'), 1, 'a second Host does not connect again');
  });

  await check('R5 route: Join assigns a room URL or reports an error', async () => {
    const page = runEntry(product.code, { search: '' });
    page.screens().actions.join('https://watchalong.test/room.html?room=joined-room');
    assertEqual(page.location.assignments[0], '/room.html?room=joined-room', 'Join assigns the room URL');
    page.screens().actions.join('a b');
    assertEqual(page.view().joinError, 'enter an invite link or a room name', 'invalid Join reports the error');
  });

  await check('R6 route: an invited room starts without a press', async () => {
    const page = runEntry(product.code, { search: '?room=demo&role=viewer&tab=t' });
    await page.settled();
    assertEqual(page.view().route, 'room', 'an invite opens the room route');
    assertEqual(page.app.room, 'demo', 'the invite supplies the room');
    assertEqual(page.count('connect'), 1, 'an invited room connects at load');
  });

  // The fakes replace the clock, so this is the only read of the probe's route (11b-2 R1).
  await check('R7 route: the clock probe reaches the room client through the lazy wrapper', async () => {
    const page = runEntry(product.code, { search: '?room=demo&role=viewer&tab=t' });
    await page.settled();
    const probeClient = page.harness.probeClient;
    assertEqual(typeof probeClient?.echo, 'function', 'the probe client has echo');
    await probeClient.echo(250);
    assertEqual(page.count('echo'), 1, 'the echo reaches the room client');
  });

  // Joint D1 F12: the wrapper restates the client by hand, which is how `echo` once went missing.
  await check('R8 route: the lazy wrapper restates every member of the room client', async () => {
    const page = runEntry(product.code, { search: '?room=demo&role=viewer&tab=t' });
    await page.settled();
    const surface = (object) => JSON.stringify(Object.getOwnPropertyNames(object).sort());
    const real = createRoomClient({ url: 'ws://127.0.0.1:9/ws', room: 'r', tabId: 't', role: 'viewer', WebSocketImpl: class {} });
    assertEqual(surface(page.harness.probeClient), surface(real), 'wrapper and client members');
  });
}
