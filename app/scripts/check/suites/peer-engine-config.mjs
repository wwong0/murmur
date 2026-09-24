import { check, assert, assertEqual } from '../harness.mjs';
import { peerEngineConfig } from '../../../public/lib/peer-engine-config.mjs';

export default async function peerEngineConfigSuite() {
  await check('peer-engine-config: preserves the room, tracker and ICE settings exactly', async () => {
    const iceServers = [{ urls: 'turn:test.example:3478', username: 'u', credential: 'c' }];
    const result = peerEngineConfig({ roomId: 'room-1', trackerUrl: 'ws://tracker.test:1', iceServers });
    assertEqual(JSON.stringify(Object.keys(result)), JSON.stringify(['core']), 'top-level keys are exact');
    assertEqual(JSON.stringify(Object.keys(result.core)), JSON.stringify(['swarmId', 'announceTrackers', 'rtcConfig']), 'core keys are exact');
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
