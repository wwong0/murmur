import { check, assert, assertEqual } from '../harness.mjs';
import { peerEngineConfig } from '../../../public/lib/peer-engine-config.mjs';
import { ENGINE_WINDOW_DEFAULTS, PRODUCT_ENGINE_WINDOWS } from '../../../public/lib/engine-windows.mjs';

// Core keys are exact: the core always carries the three
// window keys, from the product's set when none is supplied.
const CORE_KEYS = ['swarmId', 'announceTrackers', 'rtcConfig', 'highDemandTimeWindow', 'httpDownloadTimeWindow', 'p2pDownloadTimeWindow', 'segmentMemoryStorageLimit', 'httpNotReceivingBytesTimeoutMs'];

function windowsOf(core) {
  return {
    highDemandTimeWindow: core.highDemandTimeWindow,
    httpDownloadTimeWindow: core.httpDownloadTimeWindow,
    p2pDownloadTimeWindow: core.p2pDownloadTimeWindow,
  };
}

export default async function peerEngineConfigSuite() {
  await check('peer-engine-config: preserves the room, tracker and ICE settings exactly', async () => {
    const iceServers = [{ urls: 'turn:test.example:3478', username: 'u', credential: 'c' }];
    const result = peerEngineConfig({ roomId: 'room-1', trackerUrl: 'ws://tracker.test:1', iceServers });
    assertEqual(JSON.stringify(Object.keys(result)), JSON.stringify(['core']), 'top-level keys are exact');
    assertEqual(JSON.stringify(Object.keys(result.core)), JSON.stringify(CORE_KEYS), 'core keys are exact');
    assertEqual(result.core.swarmId, 'room-1', 'room becomes swarm id');
    assertEqual(JSON.stringify(result.core.announceTrackers), JSON.stringify(['ws://tracker.test:1']), 'tracker is the only announce tracker');
    assert(result.core.rtcConfig.iceServers === iceServers, 'ICE servers pass through by identity');
    assert(Object.isFrozen(result) && Object.isFrozen(result.core), 'result and core are frozen');
    assert(Object.isFrozen(result.core.announceTrackers) && Object.isFrozen(result.core.rtcConfig), 'nested config objects are frozen');
  });

  await check('peer-engine-config: an empty ICE list stays empty', async () => {
    const result = peerEngineConfig({ roomId: 'room-1', trackerUrl: 'ws://tracker.test:1', iceServers: [] });
    assertEqual(JSON.stringify(result.core.rtcConfig.iceServers), '[]', 'empty ICE list is not replaced by defaults');
  });

  await check('peer-engine-config (T1 2.1): no supplied windows builds the product set', async () => {
    const result = peerEngineConfig({ roomId: 'room-1', trackerUrl: 'ws://tracker.test:1', iceServers: [] });
    assertEqual(JSON.stringify(windowsOf(result.core)), JSON.stringify(PRODUCT_ENGINE_WINDOWS),
      'core windows default to 15/60/60, the product set');
    assertEqual(result.core.httpNotReceivingBytesTimeoutMs, 15_000, 'core default host timeout is 15 000 ms');
    assertEqual(result.core.segmentMemoryStorageLimit, 1024, 'product windows carry the memory limit');
    // Mutation probe (item 2's `...(windows ?? {})` restored): staged, then applied to
    // public/lib/peer-engine-config.mjs. `npm run check` turned this exact assertion
    // red (the core carried no window keys at all, so `windowsOf` read three
    // `undefined`s). Reverted; check green again.
  });

  await check('peer-engine-config (T1 2.1): supplied windows win over the product default', async () => {
    const result = peerEngineConfig({
      roomId: 'room-1', trackerUrl: 'ws://tracker.test:1', iceServers: [], windows: ENGINE_WINDOW_DEFAULTS,
    });
    assertEqual(JSON.stringify(windowsOf(result.core)), JSON.stringify(ENGINE_WINDOW_DEFAULTS),
      'the library set (15/3000/6000), supplied explicitly, reads back exactly — not the product default');
    assertEqual(result.core.httpNotReceivingBytesTimeoutMs, 15_000, 'supplied windows keep the product host timeout');
    assertEqual(result.core.segmentMemoryStorageLimit, 1024, 'supplied windows carry the memory limit');
  });

  await check('peer-engine-config: rejects invalid room, tracker and ICE values', async () => {
    for (const [label, input] of [
      ['room', { roomId: 1, trackerUrl: 'ws://tracker.test:1', iceServers: [] }],
      ['tracker', { roomId: 'room-1', trackerUrl: null, iceServers: [] }],
      ['ICE', { roomId: 'room-1', trackerUrl: 'ws://tracker.test:1', iceServers: {} }],
    ]) {
      let error = null;
      try { peerEngineConfig(input); } catch (caught) { error = caught; }
      assert(error instanceof TypeError, `non-${label} input throws TypeError`);
    }
  });

  const TITLE_A = `v1:${'a'.repeat(64)}`;
  const TITLE_B = `v1:${'b'.repeat(64)}`;

  await check('peer-engine-config (T11): room and title identity form the swarm id', async () => {
    const first = peerEngineConfig({ roomId: 'room-1', trackerUrl: 'ws://tracker.test:1', iceServers: [], titleId: TITLE_A });
    const second = peerEngineConfig({ roomId: 'room-1', trackerUrl: 'ws://tracker.test:1', iceServers: [], titleId: TITLE_B });
    const anotherViewer = peerEngineConfig({ roomId: 'room-1', trackerUrl: 'ws://tracker.test:1', iceServers: [], titleId: TITLE_A });
    assertEqual(first.core.swarmId, `room-1:${TITLE_A}`, 'title A is namespaced by room');
    assertEqual(second.core.swarmId, `room-1:${TITLE_B}`, 'title B is namespaced by room');
    assert(first.core.swarmId !== second.core.swarmId, 'different titles use different swarms');
    assertEqual(anotherViewer.core.swarmId, first.core.swarmId, 'same title is shared by viewers');
  });

  await check('peer-engine-config (T11): null title keeps the room swarm and malformed titles throw', async () => {
    const noTitle = peerEngineConfig({ roomId: 'room-1', trackerUrl: 'ws://tracker.test:1', iceServers: [], titleId: null });
    assertEqual(noTitle.core.swarmId, 'room-1', 'null title keeps the room swarm');
    for (const titleId of ['v1:bad', 'V1:' + 'a'.repeat(64), 42]) {
      let error = null;
      try { peerEngineConfig({ roomId: 'room-1', trackerUrl: 'ws://tracker.test:1', iceServers: [], titleId }); } catch (caught) { error = caught; }
      assert(error instanceof TypeError, `malformed title ${String(titleId)} throws TypeError`);
    }
  });
}
