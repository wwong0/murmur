import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assert, assertEqual, check } from '../harness.mjs';
import { readMountedContentManifest, validateContentManifest } from '../../harness/topology.mjs';

const LEGACY = { identity: 'step0-content-media-v1', segmentSeconds: 4, segmentCount: 1_800, totalBytes: 2_365_859_777 };
// step0/content/content-manifest.json's own shape: no identity field.
const LEGACY_MANIFEST = { segmentSeconds: 4, segmentCount: 1_800, totalBytes: 2_365_859_777 };

function refusal(content, manifest) {
  let thrown = null;
  try { validateContentManifest(content, manifest); } catch (error) { thrown = error; }
  return thrown?.message;
}

export default async function harnessContentSuite() {
  await check('harness content: a mounted manifest is retained and its identity is merged by the reader', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-content-'));
    try {
      const manifest = { ...LEGACY, targetSeconds: 4 };
      const calls = [];
      const result = readMountedContentManifest({ container: 'origin-1', runDir: root, content: LEGACY,
        exec: (argv) => { calls.push(argv); return JSON.stringify(manifest); } });
      assertEqual(result.segmentSeconds, 4, 'mounted length is returned');
      assertEqual(JSON.parse(fs.readFileSync(path.join(root, 'content-manifest.json'), 'utf8')).identity,
        LEGACY.identity, 'mounted manifest is retained in the run directory');
      assertEqual(JSON.stringify(calls[0]), JSON.stringify(['docker', 'exec', 'origin-1', 'cat', '/media/content-manifest.json']),
        'the reader uses the mounted manifest path');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('harness content: every content refusal is reached', async () => {
    assertEqual(refusal({ identity: 'wanted' }, { ...LEGACY, identity: 'other' }), 'content-identity-mismatch', 'identity mismatch');
    assertEqual(refusal({ identity: 'wanted', targetSeconds: 1 }, { identity: 'wanted', targetSeconds: 4, segmentSeconds: 1 }), 'content-target-mismatch', 'target mismatch');
    assertEqual(refusal({ hostDir: '.tmp/content' }, { ...LEGACY }), 'content-invalid', 'host directory without identity');
    assertEqual(refusal({ identity: 'wanted' }, { identity: 'wanted', segmentSeconds: null }), 'content-segment-seconds-unavailable', 'missing segment seconds');
    assertEqual(refusal(LEGACY, { ...LEGACY_MANIFEST, segmentSeconds: 1 }), 'content-legacy-mismatch', 'legacy manifest mismatch');
    assertEqual(validateContentManifest(LEGACY, LEGACY_MANIFEST).segmentSeconds, 4, 'legacy step0 values are accepted');
    assertEqual(refusal({ identity: 'dense' }, LEGACY_MANIFEST), 'content-identity-mismatch', 'a manifest with no identity matches no declared one');
  });

  // Prevention claim: the mounted manifest identity is observed at the compose-to-run boundary.
  // Mutation: dropping the identity comparison makes the first refusal case pass; restoring it keeps the case red.
  await check('harness content: a target manifest with matching identity is accepted', async () => {
    const content = { hostDir: '.tmp/1s', identity: 'dense-1s', targetSeconds: 1 };
    const manifest = { identity: 'dense-1s', targetSeconds: 1, segmentSeconds: 1, segmentCount: 7_200 };
    assertEqual(validateContentManifest(content, manifest).targetSeconds, 1, 'target content is accepted');
  });
}
