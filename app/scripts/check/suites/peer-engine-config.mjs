import { check, assert, assertEqual } from '../harness.mjs';
import { peerEngineConfig } from '../../../public/lib/peer-engine-config.mjs';
import { ENGINE_WINDOW_DEFAULTS, PRODUCT_ENGINE_WINDOWS } from '../../../public/lib/engine-windows.mjs';

// Core keys are exact: since T1 (design.md D1) the core always carries the three
// window keys, from the product's set when none is supplied.
const CORE_KEYS = ['swarmId', 'announceTrackers', 'rtcConfig', 'highDemandTimeWindow', 'httpDownloadTimeWindow', 'p2pDownloadTimeWindow', 'httpNotReceivingBytesTimeoutMs'];

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
}
