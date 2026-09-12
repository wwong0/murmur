// scripts/check/suites/playback-treatment-entry.mjs
//
// The treatment through the real bundled page (remedy-product-integration-spec.md
// 4.2 items 4 and 5): room.entry.js runs in a vm against a scripted element,
// with only the network and hls.js faked. Then the composed research arms, the
// product bundle's inputs, and the one-assignment rule on the source.
//
// Each esbuild build costs a fraction of a second; there is no browser here.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

import { check, assert, assertEqual } from '../harness.mjs';
import { FAKED_SPECIFIERS, bundleProductEntry, researchEsbuild, runEntry, withTempDir } from '../entry-harness.mjs';
import { commandThresholdFor } from '../d8-research-controller.mjs';
import { buildResearchBundle } from '../../remedy-browser-build.mjs';
import { buildOptions } from '../../build.mjs';
import { D8_COMMAND_THRESHOLD } from '../../../public/lib/drift-controller.mjs';
import { CONTROLLER_LINE_TREATMENT_FAULT_RE } from '../../../public/lib/diagnostics-overlay.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const json = (value) => JSON.stringify(value);

async function sourceFiles(dir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(full));
    else if (/\.m?js$/.test(entry.name) && !entry.name.includes('.bundle.')) found.push(full);
  }
  return found;
}

export default async function playbackTreatmentEntrySuite() {
  const product = await bundleProductEntry();

  await check('playback-treatment-entry: the page writes pitch once, after the player and before the sampler, controller and open', async () => {
    for (const specifier of [...FAKED_SPECIFIERS, './lib/drift-controller.mjs', './lib/frame-sampler.mjs']) {
      assert(product.hits.includes(specifier), `the harness substitution for ${specifier} fired`);
    }
    const page = runEntry(product.code);
    const kinds = page.kinds();
    const at = (kind) => kinds.indexOf(kind);
    const order = ['player-created', 'pitch-write', 'sampler-created', 'controller-created', 'playback-start-created'];
    for (let index = 1; index < order.length; index += 1) {
      assert(at(order[index - 1]) >= 0 && at(order[index - 1]) < at(order[index]), `${order[index - 1]} precedes ${order[index]}: ${kinds.join(', ')}`);
    }
    const constructed = page.events.find((event) => event.kind === 'controller-created');
    assert(Object.is(constructed.detail.f, D8_COMMAND_THRESHOLD), `the controller was constructed at exactly the adopted f, got ${constructed.detail.f}`);
    page.open({});
    assert(at('pitch-write') < page.kinds().indexOf('load'), 'the write precedes the load');
    assertEqual(page.count('pitch-write'), 1, 'one pitch write in the page lifetime');
    const pitch = page.app.pitch();
    assertEqual(json([pitch.treatment, pitch.controllerActive, pitch.fault]), json(['d8-pitch-disabled', true, null]), 'the seam reports the adopted treatment, active');
    const polls = page.count('controller-poll');
    page.tick();
    assertEqual(page.count('controller-poll'), polls + 1, 'each tick polls the controller once');
    assertEqual(page.app.treatmentEvidence(), null, 'without the opt-in the page keeps no event history');
  });

  await check('playback-treatment-entry: a reopen that keeps the flag keeps the controller and writes no second pitch', async () => {
    const page = runEntry(product.code);
    page.open({});
    page.open({ reopen: true, positionMs: 5000 });
    assertEqual(page.count('reopen'), 1, 'the reopen ran');
    assertEqual(page.count('pitch-write'), 1, 'and wrote no pitch');
    assertEqual(page.count('controller-created'), 1, 'the controller was not reconstructed');
    assertEqual(page.app.pitch().fault, null, 'nothing latched');
    const polls = page.count('controller-poll');
    page.tick();
    assertEqual(page.count('controller-poll'), polls + 1, 'and it keeps polling');
  });

  await check('playback-treatment-entry: pitch lost across load or reopen latches the fault, and the page shows it', async () => {
    for (const point of ['load', 'reopen']) {
      const lose = (control) => control.setPitch(true);
      const page = runEntry(product.code, point === 'load' ? { onLoad: lose } : { onReopen: lose });
      page.open({});
      if (point === 'reopen') page.open({ reopen: true, positionMs: 5000 });
      assertEqual(page.app.pitch().fault?.point, `after-${point}`, `${point}: the check after the ${point} latched`);
      const polls = page.count('controller-poll');
      page.tick();
      assertEqual(page.count('controller-poll'), polls, `${point}: no poll after the fault`);
      const view = page.app.controller();
      assertEqual(view.mode, 'treatment-fault', `${point}: the public controller view is the fault`);
      assert(view.historical && view.historical.mode !== 'treatment-fault', `${point}: with the kernel snapshot kept as historical`);
      assert(CONTROLLER_LINE_TREATMENT_FAULT_RE.test(page.controllerLine()), `${point}: the overlay paints the fault line: ${page.controllerLine()}`);
      assert(page.notices().some((text) => text.includes('reload the page to retry')), `${point}: the notice says to reload`);
      assertEqual(page.control.rateWrites().at(-1), 1, `${point}: unity was written`);
      assertEqual(page.count('pitch-write'), 1, `${point}: pitch was not rewritten`);
      page.control.setPitch(false);
      page.tick();
      assertEqual(page.count('controller-poll'), polls, `${point}: a later false read does not resume`);
    }
  });

  await check('playback-treatment-entry: a throwing reopen still runs the interlock, and without a loss it faults nothing', async () => {
    for (const lose of [true, false]) {
      const page = runEntry(product.code, {
        onReopen: (control) => {
          if (lose) control.setPitch(true);
          throw new Error('reopen failed');
        },
      });
      page.open({});
      page.open({ reopen: true, positionMs: 5000 });
      assert(page.notices().some((text) => text.includes('the player did not open: reopen failed')), `${lose}: the entry reported the failed open`);
      const polls = page.count('controller-poll');
      page.tick();
      if (lose) {
        assertEqual(page.app.pitch().fault?.point, 'after-reopen', 'the loss was caught after the throwing reopen');
        assertEqual(page.count('controller-poll'), polls, 'and the controller stays suspended');
        assertEqual(page.control.rateWrites().at(-1), 1, 'at unity');
      } else {
        assertEqual(page.app.pitch().fault, null, 'the control: a throwing reopen alone is not a treatment fault');
        assertEqual(page.count('controller-poll'), polls + 1, 'and the controller keeps polling');
      }
    }
  });

  await check('playback-treatment-entry: an unsupported element runs the page at exactly f = 0 with a notice and no expando', async () => {
    const page = runEntry(product.code, { videoOptions: { supported: false } });
    const constructed = page.events.find((event) => event.kind === 'controller-created');
    assert(Object.is(constructed.detail.f, 0), `f must be exactly 0, got ${constructed.detail.f}`);
    assertEqual(page.app.pitch().treatment, 'fallback-f0', 'the fallback is published');
    assert(page.notices().some((text) => text.includes('pitch-property-unsupported')), 'with its reason in a notice');
    assert(!Object.hasOwn(page.video, 'preservesPitch'), 'and no pitch property was created');
    const polls = page.count('controller-poll');
    page.tick();
    assertEqual(page.count('controller-poll'), polls + 1, 'the f = 0 controller polls');
  });

  await check('playback-treatment-entry: the verifier opt-in turns on the event history through the URL', async () => {
    const page = runEntry(product.code, { search: '?room=r&tab=t&treatmentEvidence=1' });
    page.open({});
    const drained = page.app.treatmentEvidence();
    assertEqual(drained.events[0].kind, 'startup', 'the first event is the startup record');
    assertEqual(drained.events[0].startup.outcome, 'treatment-established', 'carrying the outcome');
    assert(drained.events.some((event) => event.kind === 'open' && event.point === 'load'), 'the load is recorded');
    assert(drained.events.some((event) => event.kind === 'poll'), 'and the polls');
    assertEqual(drained.lost, 0, 'with nothing lost');
  });

  await check('playback-treatment-entry: composed research arms keep their own treatment behind the stand-in', async () => {
    const f = commandThresholdFor();
    await withTempDir(async (root) => {
      for (const arm of [
        { arm: 'B', treatment: 'pitch-disabled', writes: [], f: 0 },
        { arm: 'C', treatment: 'pitch-disabled', writes: [false], f },
        { arm: 'C', treatment: 'refusal-split', writes: [], f },
      ]) {
        const label = `${arm.arm}/${arm.treatment}`;
        const built = await buildResearchBundle({
          arm: arm.arm,
          root: path.join(root, `${arm.arm}-${arm.treatment}`),
          buildId: 'entry-harness',
          collectorId: 'entry-harness',
          threshold: f,
          treatment: arm.treatment,
          esbuildImpl: researchEsbuild(),
        });
        assertEqual(json(built.resolver.redirected.map((hit) => hit.role).sort()), json(['controller', 'log', 'sampler', 'treatment']), `${label}: the four named substitutions fired`);
        const inputs = Object.keys(built.metafile.inputs).map((input) => path.basename(input));
        assert(inputs.includes('research-treatment.mjs') && !inputs.includes('playback-treatment.mjs'), `${label}: the stand-in replaced the product adapter`);
        const page = runEntry(await fs.readFile(built.outfile, 'utf8'));
        assertEqual(json(page.control.pitchWrites().map((entry) => entry.value)), json(arm.writes), `${label}: the arm's own pitch writes and no other`);
        const { settings } = page.app.controller();
        assert(Object.is(settings.MIN_COMMAND_DEVIATION, arm.f), `${label}: f is ${arm.f}, got ${settings.MIN_COMMAND_DEVIATION}`);
        assertEqual(page.app.pitch(), null, `${label}: the product treatment seam is absent`);
        if (arm.arm === 'B') assertEqual(page.video.preservesPitch, true, 'B runs with the native default, true');
        // No interlock: with pitch preserved the research controller still polls.
        page.open({});
        const before = page.app.controller().polls;
        page.tick();
        assert(page.app.controller().polls > before, `${label}: the controller keeps polling`);
        assert(page.app.controller().mode !== 'treatment-fault', `${label}: and nothing latched`);
      }
    });
  });

  await check('playback-treatment-entry: the product bundle takes the real adapter and no research or test module', async () => {
    const result = await esbuild.build({ ...buildOptions('entry-harness-audit'), sourcemap: false, write: false, metafile: true });
    const inputs = Object.keys(result.metafile.inputs).map((input) => input.split(path.sep).join('/'));
    assert(inputs.includes('public/lib/playback-treatment.mjs'), 'the product adapter is an input');
    const foreign = inputs.filter((input) => input.startsWith('scripts/') || input.includes('/scripts/'));
    assertEqual(foreign.length, 0, `nothing from scripts/ reaches the product bundle: ${foreign.join(', ')}`);
  });

  await check('playback-treatment-entry: product source has one pitch assignment, in the adapter, and the player has none', async () => {
    const sites = [];
    for (const file of await sourceFiles(path.join(APP_DIR, 'public'))) {
      const count = ((await fs.readFile(file, 'utf8')).match(/\.preservesPitch\s*=(?!=)/g) ?? []).length;
      if (count > 0) sites.push({ file: path.relative(APP_DIR, file).split(path.sep).join('/'), count });
    }
    assertEqual(json(sites), json([{ file: 'public/lib/playback-treatment.mjs', count: 1 }]), 'exactly one assignment site');
    const player = await fs.readFile(path.join(APP_DIR, 'public', 'lib', 'player.mjs'), 'utf8');
    assert(!player.includes('preservesPitch'), 'the player does not touch the flag');
  });
}
