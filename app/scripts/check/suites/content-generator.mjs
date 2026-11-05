// The content generator's portability, identity and clean guard (14d design.md D1, D2).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, assertEqual, check } from '../harness.mjs';
import { CONTENT_IDENTITY, cleanRefusal, contentManifest, drawtextFont } from '../../content/prepare-content.mjs';
import { LEGACY_CONTENT_IDENTITY, LEGACY_CONTENT_MANIFEST } from '../../harness/legacy-content.mjs';

export default async function contentGeneratorSuite() {
  await check('content generator: no Windows font path off Windows, and the setting wins everywhere', async () => {
    for (const platform of ['linux', 'darwin']) {
      assertEqual(drawtextFont({ platform, env: {} }), 'font=Sans', `${platform} leaves the font to fontconfig`);
    }
    assertEqual(drawtextFont({ platform: 'win32', env: { WINDIR: 'D:\\Win' } }), "fontfile='D\\:/Win/Fonts/arial.ttf'",
      'Windows takes Arial from its own font directory, colon escaped');
    assertEqual(drawtextFont({ platform: 'linux', env: { APP_CONTENT_FONT: '/fonts/a.ttf' } }), "fontfile='/fonts/a.ttf'",
      'APP_CONTENT_FONT names the file');
  });

  await check('content generator: a fresh manifest names its own identity beside its measured bytes', async () => {
    for (const mode of ['synth', 'input']) {
      const manifest = contentManifest({ mode, mediaDuration: 8, segmentSeconds: 4, sizes: [10, 32], startedAt: 't', ffmpegVersion: 'v' });
      assertEqual(manifest.identity, CONTENT_IDENTITY[mode], `${mode} writes its identity`);
      assert(typeof manifest.identity === 'string' && manifest.identity !== LEGACY_CONTENT_IDENTITY, `${mode} never claims the legacy identity`);
      assertEqual(manifest.totalBytes, 42, `${mode} totals its measured bytes`);
      assertEqual(manifest.segmentCount, 2, `${mode} counts its segments`);
    }
  });

  await check('content generator: the clean refuses the legacy content and anything it did not write', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-generator-'));
    try {
      const dir = (name) => { const d = path.join(root, name); fs.mkdirSync(d); return d; };
      assertEqual(cleanRefusal(path.join(root, 'absent')), null, 'an absent directory may be created');
      assertEqual(cleanRefusal(dir('empty')), null, 'an empty directory may be cleaned');
      const legacy = dir('legacy');
      fs.copyFileSync(LEGACY_CONTENT_MANIFEST, path.join(legacy, 'content-manifest.json'));
      assert(/did not write/.test(cleanRefusal(legacy) ?? ''), 'the legacy content is refused');
      const loose = dir('loose');
      fs.writeFileSync(path.join(loose, 'seg-00000.m4s'), 'x');
      assert(/no readable content-manifest/.test(cleanRefusal(loose) ?? ''), 'files with no manifest are refused');
      const own = dir('own');
      fs.writeFileSync(path.join(own, 'content-manifest.json'), JSON.stringify({ identity: CONTENT_IDENTITY.synth }));
      assertEqual(cleanRefusal(own), null, "the generator's own output may be cleaned");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
