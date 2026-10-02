import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry } from '../entry-harness.mjs';
import {
  ORIGINAL_HYBRID_LOADER,
  PATCHED_HYBRID_LOADER,
  PINNED_SHA256,
  PINNED_VERSION,
  enginePatchPlugin,
  pinnedHash,
} from '../../engine-patch.mjs';
import { buildOptions } from '../../build.mjs';
import * as esbuild from 'esbuild';

const json = (value) => JSON.stringify(value);
// A string only the carried loader's code contains. Not the plugin's banner: that
// is written whether or not the loader redirect took (8b d1-findings.md F1).
const PATCHED_CODE = '"urgentWaits"';

function changedSourceLines() {
  const result = spawnSync('git', ['diff', '--no-index', '--unified=0', '--ignore-space-at-eol', ORIGINAL_HYBRID_LOADER, PATCHED_HYBRID_LOADER], { encoding: 'utf8' });
  const lines = (result.stdout ?? '').split(/\r?\n/);
  return lines.filter((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return false;
    if (line.startsWith('+') || line.startsWith('-')) return line.slice(1) !== '//# sourceMappingURL=hybrid-loader.js.map';
    return false;
  });
}

export default async function enginePatchSuite() {
  await check('engine-patch: buildOptions carries the pinned patch marker', async () => {
    const result = await esbuild.build({
      ...buildOptions('engine-patch'),
      write: false,
      sourcemap: false,
      metafile: true,
      outfile: path.join(process.cwd(), '.scratch', 'engine-patch.bundle.js'),
    });
    assert(result.outputFiles[0].text.includes(PATCHED_CODE), 'built product bundle contains the patched loader');
    // Prevention proof: opportunity is a product bundle built through the normal
    // buildOptions path; action boundary is the emitted bundle text. Mutation:
    // the plugin's hybrid-loader onResolve returns null, banner kept. Named red:
    // `built product bundle contains the patched loader`. Restore and rerun green.
  });

  await check('engine-patch: the installed engine is the pinned 3.0.1 source', async () => {
    assertEqual(PINNED_VERSION, '3.0.1', 'declared engine version');
    assertEqual(pinnedHash(), PINNED_SHA256, 'installed hybrid-loader hash');
  });

  await check('engine-patch: the copied loader differs only at marked patch sites', async () => {
    const changed = changedSourceLines();
    assert(changed.length > 0, 'the carried copy changes the loader');
    assert(changed.filter((line) => line.startsWith('+')).every((line) => line.includes('wa-patch:')), json(changed));
    // Prevention proof: opportunity is every source-line difference between the
    // installed file and the carried copy; action boundary is the source diff.
    // Mutation: edit an unrelated copied line without the marker. Named red: the
    // assertion above (the changed-line list contains an unmarked line). Restore
    // and rerun green.
  });

  await check('engine-patch: entry-harness concatenates the build plugins', async () => {
    const product = await bundleProductEntry();
    // The fakes stand in for the engine, so this bundle holds no loader: the
    // banner shows only that the plugin ran, which is this check's claim.
    assert(product.code.includes('wa-patch: p2p urgent queue'), 'entry-harness bundle carries the plugin banner');
    // Prevention proof: opportunity is the entry harness's independent esbuild
    // build; action boundary is its emitted code. Mutation: replace the plugins
    // concatenation with only `entryFakesPlugin(...)`. Named red: `entry-harness
    // bundle carries the plugin banner`. Restore and rerun green.
  });

  await check('engine-patch: the plugin resolves the product rule from the patch', async () => {
    const plugin = enginePatchPlugin();
    assert(plugin && plugin.name === 'watchalong-p2p-engine-patch', 'engine patch plugin is present');
    assert(fs.existsSync(PATCHED_HYBRID_LOADER), 'carried loader exists');
    assert(fs.existsSync(ORIGINAL_HYBRID_LOADER), 'installed loader exists');
  });
}
