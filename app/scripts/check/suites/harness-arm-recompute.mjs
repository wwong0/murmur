import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertEqual, check } from '../harness.mjs';
import { armFor } from '../../harness/arms.mjs';
import { LEGACY_CONTENT_MANIFEST, readLegacyContentManifest } from '../../harness/legacy-content.mjs';

const suiteDir = path.dirname(fileURLToPath(import.meta.url));
// A run directory that retains its own content manifest, so the recompute reads
// constructed sizes and needs neither the media nor the legacy copy.
const contentManifest = { segmentSeconds: 2, segmentSizes: [1_001, 2_002, 3_003] };
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-arm-recompute-'));
fs.writeFileSync(path.join(runDir, 'content-manifest.json'), JSON.stringify(contentManifest));
// The tracked copy's digest and length, taken from the original manifest when it was copied.
const LEGACY_SHA256 = '46e58bff4e4f7f0fad7a6553ff45ec84881566a28079f2ab4f0c9f8167ddf923';
const LEGACY_BYTES = 23_696;
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
    const recomputedContent = peer.recomputeContent(manifest, runDir);
    assert(recomputedContent !== manifest.content, 'peer content is recomputed');
    assertEqual(JSON.stringify(recomputedContent.segmentSizes), '[1001,2002,3003]', 'peer content takes the retained segment sizes');
    assertEqual(peer.recomputeAccountingMethod(manifest), peer.byteAccountingMethod, 'peer accounting uses its arm method');
    assertEqual(JSON.stringify(peer.recomputeInputExtras(manifest)), JSON.stringify({ cdpQualification: manifest.cdpQualification }),
      'peer carries qualification input');
    assertEqual(JSON.stringify(peer.driftCriterionWhenUndeclared), JSON.stringify({ verdict: 'not-drawn', reason: 'no drift bar declared' }),
      'peer supplies undeclared drift criterion');
    assertEqual(JSON.stringify(peer.driftContextExtras(manifest)), JSON.stringify({ topology: manifest.topology }),
      'peer supplies topology drift context');
    assertEqual(JSON.stringify(peer.driftRequiredFields), JSON.stringify(['topology.probePaths']), 'peer requires topology paths');
    assertEqual(peer.trackerPort, '8101', 'peer supplies tracker port');
  });

  // The first baseline-nop2p-steady attempt aborted on 'segment sizes are unavailable'.
  await check('harness arm recompute: a one-viewing host run sizes its stretch from the content', async () => {
    const host = arms[1][1];
    const oneViewing = { ...manifest, multiplierDenominator: 'one-viewing' };
    assertEqual(JSON.stringify(host.recomputeContent(oneViewing, runDir).segmentSizes), '[1001,2002,3003]',
      'one-viewing host content has the retained segment sizes');
    assertEqual(host.recomputeSegmentSeconds(oneViewing, runDir), 2, 'one-viewing host segment seconds');
  });

  // The fallback once read any manifest at its path, unchecked.
  await check('harness arm recompute: the legacy fallback reads the tracked copy and refuses other numbers', async () => {
    const bytes = fs.readFileSync(LEGACY_CONTENT_MANIFEST);
    assertEqual(bytes.length, LEGACY_BYTES, 'the tracked legacy manifest has its original length');
    assertEqual(crypto.createHash('sha256').update(bytes).digest('hex'), LEGACY_SHA256, 'the tracked legacy manifest is the original, byte for byte');
    const legacyRun = { ...manifest, content: { identity: 'step0-content-media-v1' }, multiplierDenominator: 'one-viewing' };
    const sizes = arms[1][1].recomputeContent(legacyRun).segmentSizes;
    assertEqual(sizes.length, 1_800, 'a run with no retained manifest recomputes from the legacy copy');
    assertEqual(sizes[0], 1_235_680, 'the legacy copy supplies its own first segment');
    const legacy = readLegacyContentManifest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-mismatch-'));
    try {
      for (const [field, value] of [['segmentSeconds', 2], ['segmentCount', 1_799], ['totalBytes', legacy.totalBytes + 1]]) {
        const file = path.join(dir, `${field}.json`);
        fs.writeFileSync(file, JSON.stringify({ ...legacy, [field]: value }));
        let message = null;
        try { readLegacyContentManifest(file); } catch (error) { message = error.message; }
        assertEqual(message, 'content-legacy-mismatch', `a manifest with another ${field} is refused`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  fs.rmSync(runDir, { recursive: true, force: true });
}
