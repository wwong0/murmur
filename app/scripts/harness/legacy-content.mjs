// scripts/harness/legacy-content.mjs
//
// The legacy content: the 2.3 GB rendition the retained runs measured. Its
// manifest carries no identity field, so it is known by its numbers. A tracked
// byte copy of that manifest lets the retained runs recompute without the media;
// it is read only through the check below, so no other
// manifest can hand its segment sizes to the old runs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEGACY_CONTENT_IDENTITY = 'step0-content-media-v1';
export const LEGACY_CONTENT = Object.freeze({ segmentSeconds: 4, segmentCount: 1_800, totalBytes: 2_365_859_777 });
export const LEGACY_CONTENT_MANIFEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'harness', 'legacy-content-manifest.json');

export function isLegacyContentManifest(manifest) {
  return manifest?.segmentSeconds === LEGACY_CONTENT.segmentSeconds
    && manifest?.segmentCount === LEGACY_CONTENT.segmentCount
    && manifest?.totalBytes === LEGACY_CONTENT.totalBytes
    && Array.isArray(manifest?.segmentSizes)
    && manifest.segmentSizes.length === LEGACY_CONTENT.segmentCount;
}

export function readLegacyContentManifest(file = LEGACY_CONTENT_MANIFEST) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isLegacyContentManifest(manifest)) throw new Error('content-legacy-mismatch');
  return manifest;
}
