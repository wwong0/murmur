// 8b design.md D3 (i): a host run's viewers all join before its first is
// qualified, so the room's 2 s roster settle does not start it with one viewer.
// 9b design.md D1: the first viewer's fetch is begun at its join and not awaited.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertEqual, check } from '../harness.mjs';
import { conditions, runHarness } from '../../harness-run.mjs';
import { HTTP } from '../fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const TOPOLOGY = {
  containers: { origin: 'origin-container' },
  controlUdpDrop: { ifName: 'eth1', subnet: '172.30.0.0/24', argv: [['tc']], readBack: { ingress: 'in', egress: 'out' } },
};

// One run to the cadence seam, with the order the runner navigated, qualified and
// started each echo client in.
async function orderOf(conditionName, condition) {
  const events = [];
  const tabFor = (tag) => ({
    on: () => () => {},
    send: async (method) => { if (method === 'Page.navigate') events.push(`join:${tag}`); },
    evaluate: async (source) => (source.includes('wallMs') ? { wallMs: Date.now(), performanceNowMs: 0 } : true),
  });
  const names = ['origin', 'c00', ...Array.from({ length: condition.clients }, (_, index) => `c${String(index + 1).padStart(2, '0')}`)];
  const prepared = {
    ...TOPOLOGY,
    mediaDefaultRoute: Object.fromEntries(names.map((name) => [name, { container: name, ifName: 'eth0', gateway: '172.31.0.1', readBack: [{ dst: 'default' }] }])),
  };
  const qualifier = async () => { events.push('qualify'); return { status: 'passed' }; };
  const runDir = path.join(ROOT, 'results', `check-join-order-${process.pid}-${Date.now()}`);
  let thrown = null;
  try {
    await runHarness({
      conditionName,
      condition: structuredClone(condition),
      runDir,
      originUrl: HTTP,
      clientOriginUrl: HTTP,
      topology: { prepare: async () => structuredClone(prepared), applyQdiscs: async () => [], teardown: async () => {} },
      clientFactory: async ({ tag }) => ({ tab: tabFor(tag), startEcho: async () => { events.push(`echo:${tag}`); } }),
      establishCadence: async () => { throw new Error('stop at cadence'); },
      qualifyCdpBytes: qualifier,
      beginLinkQualification: async () => { events.push('begin'); return {}; },
      finishLinkQualification: qualifier,
    });
  } catch (error) {
    thrown = error;
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
  return { events, thrown };
}

export default async function harnessJoinOrderSuite() {
  await check('harness join order: a host run joins every viewer before it qualifies the first, and starts no echo before that', async () => {
    const condition = conditions.shakedown['hostorigin-qual'];
    const { events, thrown } = await orderOf(condition.name, condition);
    // The fake tabs answer no control poll, so the run stops on that or at the cadence seam.
    assert(thrown !== null, 'the run stopped before any measure window');
    const viewers = Array.from({ length: condition.clients }, (_, index) => `c${String(index + 1).padStart(2, '0')}`);
    assert(viewers.length >= 2, 'the condition declares two or more viewers');
    const [first, ...later] = viewers;
    assertEqual(events.join(' '), ['join:c00', `join:${first}`, 'begin', ...later.map((tag) => `join:${tag}`), 'qualify', ...viewers.map((tag) => `echo:${tag}`)].join(' '), 'the host, every viewer, one qualification, then the echo clients');
    // Mutation probe, staged: arms.mjs's HOST_ARM `qualifyAfterJoins` set false.
    // `npm run check` turned 'the host, every viewer, one qualification' red
    // (join:c00 join:c01 qualify echo:c01 join:c02 echo:c02). Reverted; green again.
    // Re-run in 9b's C2 with the fetch begun at the first join: the same red, no `begin`.
  });

  await check('harness join order: an HTTP run still qualifies after its first client', async () => {
    const condition = { ...conditions.shakedown['filler-null'], clients: 2 };
    const { events, thrown } = await orderOf('shakedown/filler-null', condition);
    assertEqual(thrown?.message, 'stop at cadence', 'the run reached the cadence seam');
    assertEqual(events.join(' '), 'join:c01 qualify echo:c01 join:c02 echo:c02', 'the 6a order is unchanged');
  });
}
