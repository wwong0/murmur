// scripts/check/suites/time-echo.mjs — the round-trip probe change 2 builds on,
// and the monotonicity of the room's time reference.

import { check, assert, assertEqual, sleep } from '../harness.mjs';
import { server } from '../fixtures.mjs';
import { PROTOCOL_VERSION, ADDR_SERVER, TYPE_ECHO, TYPE_ECHO_REPLY } from '../../../public/lib/envelope.mjs';

export default async function timeEchoSuite() {
  await check('echo: the reply carries a usable round-trip sample and holds no state', async ({ member }) => {
    const a = await member('A', 'host');

    for (let i = 0; i < 5; i++) {
      const before = performance.timeOrigin + performance.now();
      a.send({ v: PROTOCOL_VERSION, type: TYPE_ECHO, to: ADDR_SERVER, id: `e-${i}`, payload: {} });
      const reply = await a.next((e) => e.type === TYPE_ECHO_REPLY);
      const after = performance.timeOrigin + performance.now();

      assertEqual(reply.replyTo, `e-${i}`, 'reply correlates');
      assertEqual(reply.seq, null, 'echo-reply is directed and outside the room order');
      assert(reply.ts.recv <= reply.ts.send, `ts.recv (${reply.ts.recv}) must not exceed ts.send (${reply.ts.send})`);
      // Server and check share a process, so the full ordering is checkable.
      assert(before <= reply.ts.recv, 'the server received after the client sent');
      assert(reply.ts.send <= after, 'the client received after the server sent');
      assert(after - before < 1000, `loopback round trip should be fast, was ${(after - before).toFixed(1)}ms`);
    }
  });

  await check('time: the room reference never moves backwards', async () => {
    let previous = server.serverNow();
    for (let i = 0; i < 20000; i++) {
      const now = server.serverNow();
      assert(now >= previous, `room time went backwards at read ${i}: ${previous} -> ${now}`);
      previous = now;
    }
    // Across a real gap too, not only inside one tight loop.
    await sleep(30);
    assert(server.serverNow() >= previous, 'room time went backwards across a delay');
  });
}
