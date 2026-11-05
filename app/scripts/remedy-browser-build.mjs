// scripts/remedy-browser-build.mjs
//
// The two isolated research bundles, and the guards that make building them
// safe to run in a tree that also holds the product's own bundle.
//
// Rules that survive any edit:
//
//  1. NOTHING IS WRITTEN OUTSIDE THE RESEARCH ROOT. esbuild runs with
//     `write: false`, the output root is resolved and checked BEFORE the build,
//     and every path esbuild returns is checked again before this file writes
//     it. An unmodified `buildOptions().outfile` must fail at the first of
//     those, so an omitted override cannot overwrite the product before anyone
//     notices.
//  2. THREE IMPORTS ARE REDIRECTED, FROM ONE IMPORTER. The resolver matches the
//     exact resolved `public/room.entry.js` and the exact three specifiers.
//     A wrapper importing the original module, and the research controller
//     importing product helpers, resolve normally — redirecting those would
//     build a page with two copies of the arithmetic in it.
//  3. f IS CALLED, NEVER TRANSCRIBED. `commandThresholdFor()` computes it here
//     and the page computes it again from the same function; both are required
//     to equal the retained offline manifest's exactly.
//  4. THE PLANT IS THE BROWSER. The mechanism driver, presentation and cadence
//     models may not enter a bundle. `mechanism-audio.mjs` may, because
//     `commandThresholdFor()` needs one pure arithmetic function from it and
//     that is a formula, not a simulated plant.
//
// TEST MACHINERY — under scripts/.

import * as esbuild from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOptions, ENTRY_POINT, OUT_FILE } from './build.mjs';
import { commandThresholdFor } from './check/d8-research-controller.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCT_BUNDLE = OUT_FILE;
export const PRODUCT_MAP = `${OUT_FILE}.map`;
export const RESEARCH_ENTRY = ENTRY_POINT;

/** The four imports the research build redirects, exactly as the entry point
 *  writes them. A specifier that stops matching is a build that silently keeps
 *  the product module, so the resolver counts its hits and the caller checks. */
export const REDIRECTED_SPECIFIERS = Object.freeze({
  './lib/drift-controller.mjs': 'controller',
  './lib/frame-sampler.mjs': 'sampler',
  './lib/frame-drift.mjs': 'log',
  // The product's pitch treatment would write pitch and pick f behind the
  // research wrappers; its stand-in does neither (integration spec 3.4).
  './lib/playback-treatment.mjs': 'treatment',
});

/** Modules that would make the page its own plant. `mechanism-audio.mjs` is
 *  deliberately absent: see rule 4. */
export const FORBIDDEN_BUNDLE_INPUTS = Object.freeze([
  'mechanism-driver.mjs', 'mechanism-presentation.mjs', 'mechanism-cadence.mjs',
  'mechanism-metrics.mjs', 'drift-plant.mjs', 'fake-frames.mjs', 'fake-probe.mjs',
]);

export const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

export function nodeBuildIo() {
  return {
    readFile: (target) => fs.readFileSync(target),
    writeFile: (target, data) => fs.writeFileSync(target, data),
    mkdir: (target) => fs.mkdirSync(target, { recursive: true }),
    exists: (target) => fs.existsSync(target),
  };
}

/**
 * f, from the formula and from the retained run, required to be the same
 * number. Exact equality: a floor that differs in its last bit is a different
 * experiment from the one the offline comparison judged.
 */
export function frozenThreshold({ manifestPath, io = nodeBuildIo() }) {
  const raw = io.readFile(manifestPath);
  const manifest = JSON.parse(raw.toString('utf8'));
  const manifestF = manifest?.formulas?.commandThreshold_f;
  const computed = commandThresholdFor();
  if (!Number.isFinite(manifestF)) throw new Error(`remedy-browser-build: the retained manifest has no finite commandThreshold_f (${manifestPath})`);
  if (computed !== manifestF) {
    throw new Error(`remedy-browser-build: commandThresholdFor() returned ${computed}, and the retained manifest froze ${manifestF}`);
  }
  return { f: computed, manifestF, manifestSha256: sha256(raw), manifestPath };
}

/** The product's own artifacts, by hash or by their absence. Absence is a
 *  recorded state, never a hash of nothing. */
export function productArtifacts(io = nodeBuildIo()) {
  const read = (target) => (io.exists(target) ? sha256(io.readFile(target)) : null);
  return { bundle: read(PRODUCT_BUNDLE), map: read(PRODUCT_MAP), bundlePath: PRODUCT_BUNDLE, mapPath: PRODUCT_MAP };
}

export function productArtifactsUnchanged(before, after) {
  const failures = [];
  if (before.bundle !== after.bundle) failures.push('product-bundle-changed');
  if (before.map !== after.map) failures.push('product-source-map-changed');
  return { unchanged: failures.length === 0, failures };
}

/** Inside, by resolved path, with no reliance on string prefixes that a `..`
 *  segment or a differently-cased drive letter could walk out of. */
export function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function assertOutputsInside(root, options) {
  const candidates = [options.outfile, options.outfile ? `${options.outfile}.map` : null, options.outdir].filter(Boolean);
  if (candidates.length === 0) throw new Error('remedy-browser-build: the build options name no output path to check');
  for (const candidate of candidates) {
    if (!isInside(root, candidate)) {
      throw new Error(`remedy-browser-build: output ${candidate} is outside the research root ${root}`);
    }
  }
  return candidates;
}

/**
 * The pitch flag each arm runs under, stated in ONE place so the manifest, the
 * bundle and the audit cannot disagree.
 *
 * `null` is "the arm writes nothing", which is the baseline and the product.
 * `false` on C is the candidate's only new treatment: the measured actuation
 * cost of repeated rate switching was pitch-dependent, so the controller is
 * given an element that is not time-stretching. It is set once before playback
 * and never toggled per correction.
 */
export const DEFAULT_TREATMENT = 'pitch-disabled';

/**
 * The candidate treatments, by name. Each names the whole of what arm C runs
 * under beyond the frozen D8 controller; B is the product in every one.
 *
 *  - `pitch-disabled` is the treatment `c5231da` ran and passed, kept as the
 *    default so the command that produced it still produces it.
 *  - `refusal-split` leaves pitch preservation where the browser put it and
 *    selects the controller's refusal split instead
 *    (`remedy-pitch-preserving-amendment.md`). It is not folded into the
 *    first: that combination was never what passed.
 */
export const TREATMENTS = Object.freeze({
  'pitch-disabled': Object.freeze({ preservesPitch: false, refusalPolicy: 'unity-hold' }),
  'refusal-split': Object.freeze({ preservesPitch: null, refusalPolicy: 'split-outside-required-threshold' }),
});

export function treatmentOf(treatment = DEFAULT_TREATMENT) {
  const found = TREATMENTS[treatment];
  if (found === undefined) throw new Error(`remedy-browser-build: unknown treatment ${treatment} (known: ${Object.keys(TREATMENTS).join(', ')})`);
  return found;
}

export const armPreservesPitch = (arm, treatment = DEFAULT_TREATMENT) => (arm === 'C' ? treatmentOf(treatment).preservesPitch : null);

/** `null` on the baseline: the product controller has no refusal policy. */
export const armRefusalPolicy = (arm, treatment = DEFAULT_TREATMENT) => (arm === 'C' ? treatmentOf(treatment).refusalPolicy : null);

/**
 * The three wrapper modules, written into the research root as real files.
 *
 * Real files rather than virtual modules so esbuild's metafile names them, the
 * run can hash them, and nothing about what the page ran depends on reading a
 * plugin. They are shims: every line of observation lives in the tested
 * `remedy-browser-page.mjs`, and the arm is chosen here and nowhere else.
 */
export function writeWrapperModules({ root, arm, io = nodeBuildIo() }) {
  const from = (target) => path.relative(root, target).split(path.sep).join('/');
  const page = from(path.join(APP_DIR, 'scripts', 'remedy-browser-page.mjs'));
  const productController = from(path.join(APP_DIR, 'public', 'lib', 'drift-controller.mjs'));
  const researchController = from(path.join(APP_DIR, 'scripts', 'check', 'd8-research-controller.mjs'));
  const sampler = from(path.join(APP_DIR, 'public', 'lib', 'frame-sampler.mjs'));
  const log = from(path.join(APP_DIR, 'public', 'lib', 'frame-drift.mjs'));

  const shared = [
    `import { createCollector, publishHarness } from '${page}';`,
    '',
    'export const collector = createCollector({',
    '  arm: __RESEARCH_ARM__,',
    '  buildId: __RESEARCH_BUILD__,',
    '  collectorId: __RESEARCH_COLLECTOR__,',
    '});',
    '',
    '// The page seam the recorder drives, published once. `window.__app` is the',
    "// product's own seam and is read through it, never recomputed.",
    'globalThis.__remedyBrowser = publishHarness({ collector, appSeam: () => globalThis.__app ?? null });',
    '',
  ].join('\n');

  const controller = arm === 'C'
    ? [
      `import { collector } from './research-collector.mjs';`,
      `import { createD8ResearchController, commandThresholdFor } from '${researchController}';`,
      `import { wrapDriftController } from '${page}';`,
      '',
      '// f is CALLED here as well as in Node, and the run requires the two to be',
      '// the same number. A build-time constant alone would prove only that a',
      '// literal survived bundling.',
      'const f = commandThresholdFor();',
      'collector.record(\'construction\', { factory: \'commandThresholdFor\', f, expected: __RESEARCH_THRESHOLD__, agrees: f === __RESEARCH_THRESHOLD__ });',
      'if (f !== __RESEARCH_THRESHOLD__) throw new RangeError(`remedy-browser: the page computed f=${f} and the run froze ${__RESEARCH_THRESHOLD__}`);',
      '',
      'export const createDriftController = wrapDriftController({',
      '  collector,',
      '  createController: createD8ResearchController,',
      '  settings: { MIN_COMMAND_DEVIATION: f },',
      '  options: { refusalPolicy: __RESEARCH_REFUSAL_POLICY__ },',
      '});',
      '',
    ].join('\n')
    : [
      `import { collector } from './research-collector.mjs';`,
      `import { createDriftController as createProductController } from '${productController}';`,
      `import { wrapDriftController } from '${page}';`,
      '',
      '// The baseline calls the product factory with its own arguments and its',
      '// own settings. Nothing is supplied here, so f stays the product zero.',
      'export const createDriftController = wrapDriftController({ collector, createController: createProductController, settings: null });',
      '',
    ].join('\n');

  // The pitch flag is the arm's ONE touch of the element, and it is chosen here
  // beside the controller: `null` on the baseline leaves the browser default
  // exactly where the product leaves it. The sampler is the seam because the
  // entry constructs it before it opens playback.
  const samplerShim = [
    `import { collector } from './research-collector.mjs';`,
    `import { createFrameSampler as createProductSampler } from '${sampler}';`,
    `import { wrapFrameSampler } from '${page}';`,
    '',
    'export const createFrameSampler = wrapFrameSampler({',
    '  collector,',
    '  createFrameSampler: createProductSampler,',
    '  preservesPitch: __RESEARCH_PRESERVES_PITCH__,',
    '});',
    '',
  ].join('\n');

  // Everything the log module exports is re-exported, because the entry point
  // is not the only importer of it in the graph and a wrapper that published a
  // narrower surface would break the sampler's own import.
  const logShim = [
    `import { collector } from './research-collector.mjs';`,
    `import { createDriftLog as createProductLog } from '${log}';`,
    `import { wrapDriftLog } from '${page}';`,
    `export * from '${log}';`,
    '',
    'export const createDriftLog = wrapDriftLog({ collector, createDriftLog: createProductLog });',
    '',
  ].join('\n');

  // The product treatment, bypassed: f = 0 unless the controller wrapper sets
  // it, no pitch write, native rate writes and no interlock. The research
  // wrappers above stay the only authority for pitch and controller selection.
  const treatmentShim = [
    'export function initializePlaybackTreatment({ video, now }) {',
    '  return {',
    '    settings: Object.freeze({ MIN_COMMAND_DEVIATION: 0 }),',
    "    treatment: 'research-bypass',",
    '    startup: null,',
    '    guard: () => true,',
    '    applyRate: (rate) => { video.playbackRate = rate; },',
    '    controllerNow: now,',
    '    pollController: (poll) => poll(),',
    '    open: (action) => action(),',
    '    view: (snapshot) => snapshot,',
    '    pitch: () => null,',
    '    drainEvidence: () => null,',
    '    faulted: false,',
    '  };',
    '}',
    '',
  ].join('\n');

  io.mkdir(root);
  const files = {
    shared: path.join(root, 'research-collector.mjs'),
    controller: path.join(root, 'research-controller.mjs'),
    sampler: path.join(root, 'research-sampler.mjs'),
    log: path.join(root, 'research-log.mjs'),
    treatment: path.join(root, 'research-treatment.mjs'),
  };
  io.writeFile(files.shared, shared);
  io.writeFile(files.controller, controller);
  io.writeFile(files.sampler, samplerShim);
  io.writeFile(files.log, logShim);
  io.writeFile(files.treatment, treatmentShim);
  return files;
}

/**
 * The resolver. It fires only for the four specifiers, and only when the
 * importer is the exact entry file; every other resolution of those same
 * specifiers — the sampler's own import of the log, the research controller's
 * import of the product arithmetic — is left alone.
 *
 * Every consideration is recorded, taken and refused alike, so "the redirect
 * did not fire" and "the redirect fired somewhere else" are different findings
 * in the retained record rather than the same silence.
 */
export function researchResolver({ entryPath, wrappers, hits }) {
  const entry = path.resolve(entryPath);
  const target = { controller: wrappers.controller, sampler: wrappers.sampler, log: wrappers.log, treatment: wrappers.treatment };
  return {
    name: 'remedy-browser-research-resolver',
    setup(build) {
      build.onResolve({ filter: /^\.\/lib\// }, (args) => {
        const role = REDIRECTED_SPECIFIERS[args.path];
        const fromEntry = path.resolve(args.importer) === entry;
        hits.push({ specifier: args.path, importer: args.importer, role: role ?? null, redirected: Boolean(role) && fromEntry });
        if (!role || !fromEntry) return null;
        return { path: target[role] };
      });
    },
  };
}

/** Did the resolver do exactly what it was supposed to, and nothing else? */
export function resolverAudit(hits) {
  const failures = [];
  const redirected = hits.filter((hit) => hit.redirected);
  const roles = new Set(redirected.map((hit) => hit.role));
  for (const role of Object.values(REDIRECTED_SPECIFIERS)) if (!roles.has(role)) failures.push(`redirect-did-not-fire-${role}`);
  if (redirected.length !== Object.keys(REDIRECTED_SPECIFIERS).length) failures.push('unexpected-substitution-count');
  const importers = new Set(redirected.map((hit) => hit.importer));
  if (importers.size > 1) failures.push('redirect-fired-for-more-than-one-importer');
  return { ok: failures.length === 0, failures, redirected, considered: hits.length };
}

/** No simulated plant reached the page. Names, not paths, so a module moved
 *  within `scripts/` is still caught. */
export function bundleInputAudit(metafile) {
  const inputs = Object.keys(metafile?.inputs ?? {});
  const forbidden = inputs.filter((input) => FORBIDDEN_BUNDLE_INPUTS.includes(path.basename(input)));
  return { inputs, forbidden, ok: forbidden.length === 0 };
}

/**
 * One arm's bundle.
 *
 * The order is the guard: product hashes, output-root check, build with nothing
 * written, resolver audit, per-path check, then the writes. A failure at any
 * step leaves the product's own artifacts exactly as they were.
 */
export async function buildResearchBundle({
  arm,
  root,
  buildId,
  collectorId,
  threshold,
  entryPath = RESEARCH_ENTRY,
  io = nodeBuildIo(),
  esbuildImpl = esbuild,
  wrappers = null,
  treatment = DEFAULT_TREATMENT,
}) {
  if (arm !== 'B' && arm !== 'C') throw new Error(`remedy-browser-build: unknown arm ${arm}`);
  treatmentOf(treatment);
  const before = productArtifacts(io);
  const files = wrappers ?? writeWrapperModules({ root, arm, io });
  const outfile = path.join(root, `room.research.${arm}.js`);
  const options = {
    ...buildOptions(buildId),
    entryPoints: [entryPath],
    outfile,
    write: false,
    metafile: true,
    define: {
      ...buildOptions(buildId).define,
      __RESEARCH_ARM__: JSON.stringify(arm),
      __RESEARCH_BUILD__: JSON.stringify(buildId),
      __RESEARCH_COLLECTOR__: JSON.stringify(collectorId),
      __RESEARCH_THRESHOLD__: JSON.stringify(threshold ?? 0),
      __RESEARCH_PRESERVES_PITCH__: JSON.stringify(armPreservesPitch(arm, treatment)),
      __RESEARCH_REFUSAL_POLICY__: JSON.stringify(armRefusalPolicy(arm, treatment)),
    },
  };
  assertOutputsInside(root, options);
  const hits = [];
  const result = await esbuildImpl.build({ ...options, plugins: [researchResolver({ entryPath, wrappers: files, hits })] });

  const resolver = resolverAudit(hits);
  if (!resolver.ok) throw new Error(`remedy-browser-build: resolver audit failed (${resolver.failures.join(', ')})`);
  const inputAudit = bundleInputAudit(result.metafile);
  if (!inputAudit.ok) throw new Error(`remedy-browser-build: a simulated plant reached the bundle (${inputAudit.forbidden.join(', ')})`);

  const written = [];
  for (const file of result.outputFiles ?? []) {
    if (!isInside(root, file.path)) throw new Error(`remedy-browser-build: esbuild returned ${file.path}, outside the research root`);
    io.writeFile(file.path, file.contents);
    written.push({ path: file.path, bytes: file.contents.length, sha256: sha256(Buffer.from(file.contents)) });
  }
  const after = productArtifacts(io);
  const untouched = productArtifactsUnchanged(before, after);
  if (!untouched.unchanged) throw new Error(`remedy-browser-build: ${untouched.failures.join(', ')}`);

  const bundle = written.find((file) => file.path === outfile);
  if (bundle === undefined) throw new Error('remedy-browser-build: esbuild produced no bundle at the requested path');
  return {
    arm,
    buildId,
    collectorId,
    outfile,
    bundleSha256: bundle.sha256,
    bundleBytes: bundle.bytes,
    written,
    wrappers: files,
    resolver,
    inputs: inputAudit.inputs,
    metafile: result.metafile,
    productArtifacts: { before, after, unchanged: untouched.unchanged },
  };
}
