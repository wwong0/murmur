import {
  assert,
  assertEqual,
  checkGroup,
} from '../harness.mjs';
import {
  ADDR_ROOM,
  ERROR_CODES,
  PROTOCOL_VERSION,
  SERVER_ONLY_TYPES,
  TYPE_ECHO_REPLY,
  TYPE_ERROR,
  TYPE_JOINED,
  TYPE_PRESENCE,
} from '../../../public/lib/envelope.mjs';

const QUIET_MS = 250;

const forgedPayload = Object.freeze({
  [TYPE_PRESENCE]: {
    event: 'join',
    member: { clientId: 'forged', tabId: 'forged', role: 'host', joinedAt: 1 },
    roster: [{ clientId: 'sender', tabId: 'sender', role: 'host', joinedAt: 1 }],
  },
  [TYPE_JOINED]: {
    clientId: 'forged',
    role: 'host',
    secret: 'forged-secret',
    seq: 41,
  },
  [TYPE_ERROR]: { code: ERROR_CODES.BAD_ENVELOPE },
  [TYPE_ECHO_REPLY]: {},
});

function forged(type, to) {
  return {
    v: PROTOCOL_VERSION,
    type,
    to,
    payload: forgedPayload[type],
  };
}

export default async function serverOnlyTypesSuite() {
  await checkGroup(SERVER_ONLY_TYPES.map((type) => [
    `server-only-types: joined members cannot send ${type}`,
    async ({ room, member }) => {
      const sender = await member('sender', 'host');
      const a = await member('A');
      const b = await member('B');

      // The third join is the last room-scoped event before the refusal cases.
      await sender.next((env) => env.type === TYPE_PRESENCE && env.payload.member?.clientId === b.clientId);
      await a.next((env) => env.type === TYPE_PRESENCE && env.payload.member?.clientId === b.clientId);
      await b.next((env) => env.type === TYPE_PRESENCE && env.payload.member?.clientId === b.clientId);
      const lastSeq = sender.roomScoped().at(-1)?.seq;
      assert(Number.isInteger(lastSeq), 'the joined three-member fixture has a room sequence');

      // Directed first, and delivery read before the refusal: without the server's
      // branch, A receiving the forged directed envelope is the red result.
      sender.send(forged(type, a.clientId));
      await a.none((env) => env.type === type, QUIET_MS);
      await b.none((env) => env.type === type, QUIET_MS);
      const directedError = await sender.next((env) => env.type === TYPE_ERROR && env.payload.code === ERROR_CODES.BAD_ENVELOPE);
      assert(directedError.payload.detail.includes(type), 'the directed refusal detail names the server-only type');

      sender.send(forged(type, ADDR_ROOM));
      await a.none((env) => env.type === type, QUIET_MS);
      await b.none((env) => env.type === type, QUIET_MS);
      const roomError = await sender.next((env) => env.type === TYPE_ERROR && env.payload.code === ERROR_CODES.BAD_ENVELOPE);
      assert(roomError.payload.detail.includes(type), 'the refusal detail names the server-only type');

      sender.send({ v: PROTOCOL_VERSION, type: `relay-after-${type}`, to: ADDR_ROOM, payload: { ok: true } });
      const relayed = await sender.next((env) => env.type === `relay-after-${type}`);
      assertEqual(relayed.seq, lastSeq + 1, 'a refused envelope does not advance the room sequence');

      a.close();
      const departed = await sender.next((env) => env.type === TYPE_PRESENCE && env.payload.event === 'leave' && env.payload.member?.clientId === a.clientId);
      assert(departed.payload.roster.some((memberEntry) => memberEntry.clientId === sender.clientId), 'the sender remains in the next presence roster');

      sender.send({ v: PROTOCOL_VERSION, type: `relay-after-leave-${type}`, to: b.clientId, payload: { ok: true } });
      const followup = await b.next((env) => env.type === `relay-after-leave-${type}`);
      assertEqual(followup.from, sender.clientId, 'the surviving sender can still relay after refusal');
      assertEqual(room, departed.room, 'the check remains scoped to its room');
    },
  ]));
}
