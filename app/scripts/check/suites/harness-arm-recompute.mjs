import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertEqual, check } from '../harness.mjs';
import { armFor } from '../../harness/arms.mjs';

const suiteDir = path.dirname(fileURLToPath(import.meta.url));
const contentManifestPath = path.resolve(suiteDir, '../../../../step0/content/content-manifest.json');
const contentManifest = JSON.parse(fs.readFileSync(contentManifestPath, 'utf8'));
const manifest = {
  byteAccountingMethod: 'constructed-accounting',
  cdpQualification: { receipt: { requestId: 'constructed' } },
  content: { identity: 'step0-content-media-v1', frameRate: 24 },
  topology: { probePaths: { c01: { peerLinksShaped: false } } },
};

const arms = [
  ['http', armFor({ delivery: 'http' })],
  ['host', armFor({ delivery: 'host' })],
  ['peer', armFor({ delivery: 'host', peerExchange: true })],
];

export default async function harnessArmRecomputeSuite() {
  await check('harness arm recompute: every arm owns the recompute behavior', async () => {
    for (const [name, arm] of arms) {
      assert(typeof arm.recomputeContent === 'function', `${name} content recompute`);
      assert(typeof arm.recomputeAccountingMethod === 'function', `${name} accounting recompute`);
      assert(typeof arm.recomputeInputExtras === 'function', `${name} input extras recompute`);
      assert('driftCriterionWhenUndeclared' in arm, `${name} drift criterion property`);
      assert(typeof arm.driftContextExtras === 'function', `${name} drift context extras`);
      assert(Array.isArray(arm.driftRequiredFields), `${name} drift required fields`);
      assert('trackerPort' in arm, `${name} tracker port property`);
    }
  });

  await check('harness arm recompute: peer and non-peer arms retain their distinct inputs', async () => {
    for (const [name, arm] of arms.slice(0, 2)) {
      assert(arm.recomputeContent(manifest) === manifest.content, `${name} content is unchanged`);
      assertEqual(arm.recomputeAccountingMethod(manifest), 'constructed-accounting', `${name} accounting is unchanged`);
      assertEqual(JSON.stringify(arm.recomputeInputExtras(manifest)), '{}', `${name} has no input extras`);
      assertEqual(arm.driftCriterionWhenUndeclared, null, `${name} has no undeclared drift criterion`);
      assertEqual(JSON.stringify(arm.driftContextExtras(manifest)), '{}', `${name} has no drift context extras`);
      assertEqual(JSON.stringify(arm.driftRequiredFields), '[]', `${name} has no drift required fields`);
      assertEqual(arm.trackerPort, null, `${name} has no tracker port`);
    }

    const peer = arms[2][1];
    const recomputedContent = peer.recomputeContent(manifest);
    assert(recomputedContent !== manifest.content, 'peer content is recomputed');
    assertEqual(recomputedContent.segmentSizes.length, contentManifest.segmentSizes.length, 'peer content has segment sizes');
    assertEqual(recomputedContent.segmentSizes[0], contentManifest.segmentSizes[0], 'peer content preserves segment bytes');
    assertEqual(peer.recomputeAccountingMethod(manifest), peer.byteAccountingMethod, 'peer accounting uses its arm method');
    assertEqual(JSON.stringify(peer.recomputeInputExtras(manifest)), JSON.stringify({ cdpQualification: manifest.cdpQualification }),
      'peer carries qualification input');
    assertEqual(JSON.stringify(peer.driftCriterionWhenUndeclared), JSON.stringify({ verdict: 'not-drawn', reason: 'design.md D5' }),
      'peer supplies undeclared drift criterion');
    assertEqual(JSON.stringify(peer.driftContextExtras(manifest)), JSON.stringify({ topology: manifest.topology }),
      'peer supplies topology drift context');
    assertEqual(JSON.stringify(peer.driftRequiredFields), JSON.stringify(['topology.probePaths']), 'peer requires topology paths');
    assertEqual(peer.trackerPort, '8101', 'peer supplies tracker port');
  });

  // 8a's first baseline-nop2p-steady attempt aborted on 'segment sizes are unavailable'.
  await check('harness arm recompute: a one-viewing host run sizes its stretch from the content', async () => {
    const host = arms[1][1];
    const oneViewing = { ...manifest, multiplierDenominator: 'one-viewing' };
    assertEqual(host.recomputeContent(oneViewing).segmentSizes?.length, contentManifest.segmentSizes.length,
      'one-viewing host content has segment sizes');
    assertEqual(host.recomputeSegmentSeconds(oneViewing), contentManifest.segmentSeconds, 'one-viewing host segment seconds');
  });

  // arms.mjs is excluded: armFor is where peerExchange selects the arm.
  await check('harness arm recompute: recompute branches do not inspect peerExchange', async () => {
    const figuresDir = path.resolve(suiteDir, '../../figures');
    const files = [
      '../../harness-figures.mjs',
      '../../harness/topology.mjs',
      ...fs.readdirSync(figuresDir).filter((name) => name.endsWith('.mjs')).map((name) => `../../figures/${name}`),
    ];
    const branch = /peerExchange\s*(?:===|!==)\s*true/;
    for (const relative of files) {
      const source = fs.readFileSync(path.resolve(suiteDir, relative), 'utf8');
      assert(!branch.test(source), `${relative} has no peerExchange comparison branch`);
    }
  });
}
