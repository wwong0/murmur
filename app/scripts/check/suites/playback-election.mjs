import {
  assert,
  assertEqual,
  check,
} from '../harness.mjs';
import {
  TYPE_PLAYBACK_OPERATION,
  TYPE_PLAYBACK_STATE_ANSWER,
  TYPE_PLAYBACK_STATE_REQUEST,
} from '../../../public/lib/envelope.mjs';
import { createPlaybackAcquisition } from '../../../public/lib/playback-acquisition.mjs';
import { electCreator } from '../../../public/lib/state-election.mjs';
import { mediaMsAt } from '../../../public/lib/playback-state.mjs';

const NOW = 1000;
const SETTINGS = Object.freeze({
  transitionLeadMs: 0,
  maxFutureMs: 1000,
  requestTimeoutMs: 10,
  backoffMs: 2,
  autoStart: () => true,
});

function roster(ids) {
  return ids.map((clientId) => ({ clientId, role: 'viewer' }));
}

function waitFor(test, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (test()) resolve();
      else if (Date.now() >= deadline) reject(new Error(`timed out waiting for ${label}`));
      else setTimeout(poll, 1);
    };
    poll();
  });
}

class FakeNetwork {
  constructor() {
    this.clients = new Map();
    this.nextSeq = 100;
    this.response = undefined;
    this.routeCreate = (env) => this.deliver(env);
  }

  add(id, { bareAnswers = false } = {}) {
    const events = new Map();
    const eventSubscribers = new Map();
    const client = {
      clientId: id,
      tabId: id,
      role: 'viewer',
      bareAnswers,
      on: (type, callback) => this.subscribe(events, type, callback),
      onEvent: (type, callback) => this.subscribe(eventSubscribers, type, callback),
      request: ({ to }) => Promise.resolve().then(() => this.request(id, to)),
      send: (env) => {
        if (env.type === TYPE_PLAYBACK_STATE_ANSWER) {
          this.response = { payload: client.bareAnswers ? null : env.payload };
          return env;
        }
        if (env.type === TYPE_PLAYBACK_OPERATION) {
          this.routeCreate({
            ...env,
            seq: this.nextSeq++,
            from: id,
            ts: { send: NOW, recv: NOW },
          }, id);
        }
        return env;
      },
      emit: (type, value) => {
        for (const callback of events.get(type) ?? []) callback(value);
      },
      emitEvent: (type, value) => {
        for (const callback of eventSubscribers.get(type) ?? []) callback(value);
      },
    };
    this.clients.set(id, client);
    return client;
  }

  subscribe(groups, type, callback) {
    const callbacks = groups.get(type) ?? [];
    callbacks.push(callback);
    groups.set(type, callbacks);
    return () => groups.set(type, callbacks.filter((entry) => entry !== callback));
  }

  request(from, to) {
    const target = this.clients.get(to);
    this.response = undefined;
    if (target) target.emit(TYPE_PLAYBACK_STATE_REQUEST, { from, id: `${from}-request`, payload: {} });
    return this.response;
  }

  deliver(env, ids = [...this.clients.keys()]) {
    for (const id of ids) this.clients.get(id)?.emit(TYPE_PLAYBACK_OPERATION, env);
  }
}

function makeDriver(network, id, { clock = { sharedNow: () => NOW }, bareAnswers = false } = {}) {
  const client = network.add(id, { bareAnswers });
  let lineage = 0;
  const driver = createPlaybackAcquisition({
    client,
    clock,
    settings: SETTINGS,
    mintLineage: () => `${id}-lineage-${lineage++}`,
  });
  return { client, driver };
}

function join(client, ids) {
  client.emitEvent('joined', { roster: roster(ids), seq: 0 });
}

function prime(network, item, version) {
  const route = network.routeCreate;
  network.nextSeq = version;
  network.routeCreate = (env) => network.deliver(env, [item.client.clientId]);
  try {
    join(item.client, [item.client.clientId]);
    assertEqual(item.driver.state?.version, version, `${item.client.clientId} seeded version`);
  } finally {
    network.routeCreate = route;
  }
}

function dispose(...items) {
  for (const item of items) item?.driver.dispose();
}

export default async function playbackElectionSuite() {
  await check('playback election: none reports the held version', async () => {
    const network = new FakeNetwork();
    let available = true;
    const item = makeDriver(network, 'A', { clock: { sharedNow: () => (available ? NOW : null) } });
    try {
      prime(network, item, 41);
      available = false;
      join(item.client, ['A', 'B']);
      const answer = network.request('REQUESTER', 'A');
      assertEqual(answer.payload.state, null, 'unresolved member answers none');
      assertEqual(answer.payload.heldVersion, 41, 'none answer carries the state held before membership');
    } finally {
      dispose(item);
    }
  });

  await check('playback election: lower id creates for two fresh joiners', async () => {
    const network = new FakeNetwork();
    let available = false;
    const a = makeDriver(network, 'A', { clock: { sharedNow: () => (available ? NOW : null) } });
    const b = makeDriver(network, 'B');
    try {
      join(a.client, ['A']);
      join(b.client, ['A', 'B']);
      available = true;
      join(a.client, ['A', 'B']);
      await waitFor(() => a.driver.state !== null && b.driver.state !== null, 'fresh members to resolve');
      assertEqual(a.driver.snapshot.created, 1, 'lower id creates once');
      assertEqual(b.driver.snapshot.created, 0, 'other fresh member does not create');
      assertEqual(a.driver.snapshot.identity.lineage, b.driver.snapshot.identity.lineage, 'both report the elected lineage');
    } finally {
      dispose(a, b);
    }
  });

  await check('playback election: highest held version recreates its mappings', async () => {
    const network = new FakeNetwork();
    const a = makeDriver(network, 'A');
    const b = makeDriver(network, 'B');
    const c = makeDriver(network, 'C');
    try {
      prime(network, a, 41);
      prime(network, b, 38);
      const held = a.driver.state;
      const createdBefore = a.driver.snapshot.created;
      join(a.client, ['A', 'B', 'C']);
      join(b.client, ['A', 'B', 'C']);
      join(c.client, ['A', 'B', 'C']);
      assertEqual(electCreator({
        selfId: 'A',
        selfHeldVersion: 41,
        answers: [{ clientId: 'B', heldVersion: 38 }, { clientId: 'C', heldVersion: null }],
      }), 'A', 'highest held version wins the election');
      assertEqual(electCreator({
        selfId: 'A',
        selfHeldVersion: 38,
        answers: [{ clientId: 'B', heldVersion: 41 }, { clientId: 'C', heldVersion: null }],
      }), 'B', 'with the two versions swapped the creator follows the version, not the id');
      await waitFor(() => a.driver.state !== null && b.driver.state !== null && c.driver.state !== null, 'held members to recreate');
      assertEqual(a.driver.snapshot.created - createdBefore, 1, 'latest holder creates once');
      assertEqual(b.driver.snapshot.created, 1, 'older holder does not create a second state');
      assertEqual(c.driver.snapshot.created, 0, 'member without a held state does not create');
      for (const instant of [held.current.atSharedMs - 100, held.current.atSharedMs, held.current.atSharedMs + 100]) {
        assertEqual(mediaMsAt(a.driver.state, instant), mediaMsAt(held, instant), `held mapping survives at ${instant}`);
      }
      assertEqual(a.driver.snapshot.identity.lineage, b.driver.snapshot.identity.lineage, 'older holder applies the winner lineage');
      assertEqual(a.driver.snapshot.identity.lineage, c.driver.snapshot.identity.lineage, 'fresh member applies the winner lineage');
    } finally {
      dispose(a, b, c);
    }
  });

  await check('playback election: an unanswered member blocks three rounds', async () => {
    const network = new FakeNetwork();
    const a = makeDriver(network, 'A');
    const b = makeDriver(network, 'B');
    try {
      join(a.client, ['A', 'SILENT', 'B']);
      join(b.client, ['A', 'SILENT', 'B']);
      await waitFor(() => a.driver.snapshot.requests >= 6, 'three election rounds');
      assertEqual(a.driver.snapshot.created, 0, 'missing answer prevents creation');
      assertEqual(a.driver.snapshot.resolved, false, 'unresolved member stays unresolved');
    } finally {
      dispose(a, b);
    }
  });

  await check('playback election: two elections from different rosters resolve to one state', async () => {
    const network = new FakeNetwork();
    const a = makeDriver(network, 'A');
    const b = makeDriver(network, 'B');
    const c = makeDriver(network, 'C');
    // The room server orders operations, so every member sees the two creations
    // in one order. Both are held back until both have been issued.
    const issued = [];
    network.routeCreate = (env) => { issued.push(env); };
    try {
      join(a.client, ['A', 'B']);
      await waitFor(() => issued.length === 1, 'first roster election');
      join(c.client, ['B', 'C']);
      join(b.client, ['B', 'C']);
      await waitFor(() => issued.length === 2, 'second roster election');
      const [first, second] = issued;
      assertEqual(first.from, 'A', 'A elected itself from its roster');
      assertEqual(second.from, 'B', 'B elected itself from its roster');
      assert(first.payload.lineage !== second.payload.lineage, 'the two creations carry different lineages');
      network.deliver(first);
      network.deliver(second);
      for (const item of [a, b, c]) {
        assertEqual(item.driver.snapshot.identity.lineage, first.payload.lineage, `${item.client.clientId} holds the first delivered creation`);
        assert(item.driver.snapshot.rejected.stale >= 1, `${item.client.clientId} rejects the second creation`);
      }
    } finally {
      dispose(a, b, c);
    }
  });

  await check('playback election: a silent member still blocks creation', async () => {
    const network = new FakeNetwork();
    const a = makeDriver(network, 'A');
    try {
      join(a.client, ['A', 'SILENT']);
      await waitFor(() => a.driver.snapshot.requests >= 3, 'silent member retry rounds');
      assertEqual(a.driver.snapshot.created, 0, 'silent member does not create a state');
      assertEqual(a.driver.snapshot.resolved, false, 'silent member leaves the client unresolved');
    } finally {
      dispose(a);
    }
  });

  await check('playback election: bare null is not a none answer', async () => {
    const network = new FakeNetwork();
    const a = makeDriver(network, 'A');
    const b = makeDriver(network, 'B', { bareAnswers: true });
    try {
      prime(network, a, 42);
      prime(network, b, 41);
      const createdBefore = a.driver.snapshot.created;
      join(a.client, ['A', 'B']);
      join(b.client, ['A', 'B']);
      await waitFor(() => a.driver.snapshot.requests >= 3, 'bare null retries');
      assertEqual(a.driver.snapshot.created, createdBefore, 'bare null blocks election');
      assertEqual(a.driver.snapshot.resolved, false, 'bare null leaves the client unresolved');
    } finally {
      dispose(a, b);
    }
  });
}
