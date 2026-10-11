import { assert, assertEqual, check } from '../harness.mjs';
import { socketControlResponseShape, startSocketControl } from '../../../harness/socket-control.mjs';
import { finalizeRosterEvent } from '../../harness/roster-event.mjs';
import { startLoop } from '../../harness-run.mjs';

// The streams of a real drop: the tab leaves, rejoins as a new client, and leaves again at teardown.
function droppedStreams() {
  const frame = (seq, event, tabId, clientId) => ({ seq, event, tabId, clientId, recvSharedMs: 1_000 + seq, cdpMs: seq });
  const seen = [frame(9, 'leave', 'c03', 'c-old'), frame(10, 'join', 'c03', 'c-new'), frame(11, 'leave', 'c00', 'c-host')];
  const session = (tag, records) => ({ tag, presenceRecorder: { snapshot: () => records } });
  return [session('c01', seen), session('c02', seen), session('c03', [frame(10, 'join', 'c03', 'c-new')]),
    session('c04', [...seen, frame(14, 'leave', 'c03', 'c-new')])];
}

export default async function harnessSocketControlSuite() {
  // Serial: the bound on elapsed time is the assertion.
  await check('10b: a stopped loop wakes from its sleep instead of waiting its interval out', async () => {
    let ran = 0;
    const loop = startLoop(async () => { ran += 1; }, 60_000, () => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const began = Date.now();
    loop.stop();
    const settled = await Promise.race([loop.promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 2_000))]);
    assertEqual(ran, 1, 'the task ran once and the loop slept');
    assert(settled && Date.now() - began < 2_000, 'the loop ended when it was stopped');
  });
  await check('10b: a dropped socket\'s leave is the member\'s own, not its tab\'s leave at teardown', async () => {
    const state = { condition: { clients: 4 }, kind: 'drop-socket', client: 'c03', tabId: 'c03', clientId: 'c-old' };
    const value = finalizeRosterEvent(state, droppedStreams(), null);
    assertEqual(value.leave?.seq, 9, 'the leave is the dropped member\'s');
    assertEqual(value.rejoin?.seq, 10, 'the rejoin is the first join after it');
    assertEqual(value.rejoin?.clientId, 'c-new', 'the rejoin carries the new member id');
    assertEqual(value.observed, true, 'every other viewer holds the leave frame');
  });
  await check('10b H14: socket control terminates only the member with the requested tab id', async () => {
    let terminated = 0;
    const member = { clientId: 'client-a', tabId: 'c03', ws: { terminate: () => { terminated += 1; } } };
    const other = { clientId: 'client-b', tabId: 'c04', ws: { terminate: () => { terminated += 10; } } };
    const roomServer = { rooms: new Map([['room-a', { members: new Map([[member.clientId, member], [other.clientId, other]]) }]]) };
    const control = startSocketControl({ roomServer, port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => control.server.once('listening', resolve));
    const port = control.server.address().port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/terminate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: 'room-a', tabId: 'c03' }),
      });
      const value = await response.json();
      assert(response.ok, 'known tab returns success');
      assert(socketControlResponseShape(value), 'known tab response has the control shape');
      assertEqual(value.clientId, 'client-a', 'the requested member is reported');
      assertEqual(terminated, 1, 'only the requested websocket is terminated');

      const missing = await fetch(`http://127.0.0.1:${port}/terminate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: 'room-a', tabId: 'unknown' }),
      });
      const missingValue = await missing.json();
      assertEqual(missing.status, 404, 'unknown tab returns 404');
      assertEqual(missingValue.terminated, false, 'unknown tab terminates nothing');
      assertEqual(terminated, 1, 'unknown tab leaves both sockets alone');
    } finally {
      await control.close();
    }
  });
}
