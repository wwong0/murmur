// scripts/check/suites/robustness.mjs — malformed input is refused in isolation,
// without collateral damage to anyone else.

import { check, assert, assertEqual } from '../harness.mjs';
import { PROTOCOL_VERSION, ADDR_ROOM, TYPE_ERROR, ERROR_CODES } from '../../../public/lib/envelope.mjs';

export default async function robustnessSuite() {
  await check('robustness: bad JSON, pre-join traffic and a double join are each refused in isolation', async ({ room, peer, member }) => {
    const bystander = await member('bystander', 'viewer', { tabId: 'Z' });
    const bystanderSeen = bystander.received.length;

    // Unparseable bytes.
    const p1 = await peer('P1');
    p1.sendRaw('{ this is not json ');
    const e1 = await p1.next((e) => e.type === TYPE_ERROR);
    assertEqual(e1.payload.code, ERROR_CODES.BAD_ENVELOPE, 'bad JSON code');
    assert(!p1.closed, 'bad JSON does not close the connection');

    // A structurally invalid envelope.
    p1.send({ v: PROTOCOL_VERSION, type: 'shout' });
    const e2 = await p1.next((e) => e.type === TYPE_ERROR);
    assertEqual(e2.payload.code, ERROR_CODES.BAD_ENVELOPE, 'missing routing field code');
    assert(typeof e2.payload.detail === 'string' && e2.payload.detail.length > 0, 'the refusal says what was wrong');

    // Traffic before joining.
    p1.send({ v: PROTOCOL_VERSION, type: 'shout', to: ADDR_ROOM, payload: {} });
    const e3 = await p1.next((e) => e.type === TYPE_ERROR);
    assertEqual(e3.payload.code, ERROR_CODES.NOT_JOINED, 'pre-join code');

    // A second join on one connection.
    const p2 = await peer('P2');
    await p2.join({ room, tabId: 'P2', role: 'viewer' });
    const e4 = await p2.join({ room, tabId: 'P2', role: 'host' });
    assertEqual(e4.type, TYPE_ERROR, 'a second join is refused');
    assertEqual(e4.payload.code, ERROR_CODES.ALREADY_JOINED, 'double join code');
    // The refusal changed nothing: still a viewer, and still no host.
    p2.send({ v: PROTOCOL_VERSION, type: 'shout', to: ADDR_ROOM, payload: {} });
    await p2.next((e) => e.type === 'shout');

    // Throughout all of that, the bystander stayed connected and its membership
    // was untouched.
    assert(!bystander.closed, 'an unrelated client stays connected');
    const bystanderErrors = bystander.received.slice(bystanderSeen).filter((e) => e.type === TYPE_ERROR);
    assertEqual(bystanderErrors.length, 0, 'an unrelated client receives no errors meant for others');
  });
}
