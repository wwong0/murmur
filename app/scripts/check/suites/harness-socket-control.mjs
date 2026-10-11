import { assert, assertEqual, check } from '../harness.mjs';
import { socketControlResponseShape, startSocketControl } from '../../../harness/socket-control.mjs';

export default async function harnessSocketControlSuite() {
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
