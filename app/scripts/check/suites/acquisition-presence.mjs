import { assertEqual, check } from '../harness.mjs';
import {
  TYPE_PLAYBACK_OPERATION,
  TYPE_PRESENCE,
} from '../../../public/lib/envelope.mjs';
import { createPlaybackAcquisition } from '../../../public/lib/playback-acquisition.mjs';

const SETTINGS = Object.freeze({
  transitionLeadMs: 0,
  maxFutureMs: 1000,
  requestTimeoutMs: 1000,
  backoffMs: 1000,
});

class FakeClient {
  constructor(clientId) {
    this.clientId = clientId;
    this.role = 'viewer';
    this.requests = [];
    this.events = new Map();
    this.eventEvents = new Map();
  }

  on(type, fn) {
    const callbacks = this.events.get(type) ?? [];
    callbacks.push(fn);
    this.events.set(type, callbacks);
    return () => this.events.set(type, callbacks.filter((callback) => callback !== fn));
  }

  onEvent(type, fn) {
    const callbacks = this.eventEvents.get(type) ?? [];
    callbacks.push(fn);
    this.eventEvents.set(type, callbacks);
    return () => this.eventEvents.set(type, callbacks.filter((callback) => callback !== fn));
  }

  request({ to }) {
    this.requests.push(to);
    return new Promise(() => {});
  }

  send() {}

  emit(type, value) {
    for (const callback of this.events.get(type) ?? []) callback(value);
  }

  emitEvent(type, value) {
    for (const callback of this.eventEvents.get(type) ?? []) callback(value);
  }
}

function makeDriver(client) {
  return createPlaybackAcquisition({
    client,
    clock: { sharedNow: () => 1000 },
    settings: SETTINGS,
    mintLineage: () => 'lineage',
  });
}

function roster(clientId) {
  return [
    { clientId, role: 'viewer' },
    { clientId: 'host', role: 'host' },
  ];
}

function creation() {
  return {
    type: TYPE_PLAYBACK_OPERATION,
    seq: 1,
    from: 'host',
    ts: { recv: 1000 },
    payload: {
      kind: 'create',
      lineage: 'held-lineage',
      current: { playing: false, atSharedMs: 1000, mediaMs: 0 },
      previous: null,
      controlMode: 'host',
    },
  };
}

export default async function acquisitionPresenceSuite() {
  await check('acquisition presence: member-relayed presence cannot change a held roster or permission', async () => {
    const client = new FakeClient('viewer');
    const driver = makeDriver(client);
    try {
      client.emitEvent('joined', { seq: 0, roster: roster(client.clientId) });
      client.emit(TYPE_PLAYBACK_OPERATION, creation());
      assertEqual(driver.permitted('play'), false, 'host-mode permission starts from the real host roster');
      client.emit(TYPE_PRESENCE, {
        from: 'c-member',
        seq: 2,
        payload: { roster: [{ clientId: client.clientId, role: 'viewer' }] },
      });
      // Guarded claim: removing the ADDR_SERVER guard makes this roster-unchanged
      // assertion red; the mutation is named in the executor report.
      assertEqual(driver.permitted('play'), false, 'a member-relayed roster cannot remove the controlling host');
    } finally {
      driver.dispose();
    }
  });

  await check('acquisition presence: member-relayed presence cannot abandon an awaiting request pass', async () => {
    const client = new FakeClient('viewer');
    const driver = makeDriver(client);
    try {
      client.emitEvent('joined', { seq: 0, roster: roster(client.clientId) });
      assertEqual(client.requests.length, 1, 'the initial request pass targets the host');
      assertEqual(client.requests[0], 'host', 'the request target is the original roster member');
      client.emit(TYPE_PRESENCE, {
        from: 'c-member',
        seq: 1,
        payload: { roster: [{ clientId: client.clientId, role: 'viewer' }] },
      });
      assertEqual(driver.snapshot.abandoned, 0, 'a member-relayed roster cannot abandon the request pass');
      assertEqual(client.requests.length, 1, 'the request pass still targets the original member');
    } finally {
      driver.dispose();
    }
  });
}
