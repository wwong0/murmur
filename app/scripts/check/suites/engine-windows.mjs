import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { ENGINE_WINDOW_DEFAULTS, PRODUCT_ENGINE_WINDOWS, validateEngineWindows } from '../../../public/lib/engine-windows.mjs';
import { armFor } from '../../harness/arms.mjs';
import { conditionValidationReason } from '../../harness-run.mjs';

const json = (value) => JSON.stringify(value);
const suiteDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(suiteDir, '../..');
const bundlePath = path.resolve(suiteDir, '../../../../.tmp/check-engine-windows-core.mjs');
const supplied = Object.freeze({ highDemandTimeWindow: 15, httpDownloadTimeWindow: 60, p2pDownloadTimeWindow: 60 });

async function drain() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function pageWith(globals = {}) {
  return runEntry(product.code, {
    role: 'viewer',
    settings: { delivery: 'host', trackerUrl: 'ws://tracker.test:1', iceServers: [] },
    globals,
  });
}

function loadEvent(page) {
  return page.events.find((event) => event.kind === 'load');
}

function windowReading(overrides = {}) {
  return { declared: null, expected: ENGINE_WINDOW_DEFAULTS, inForce: ENGINE_WINDOW_DEFAULTS, pageError: null, ...overrides };
}

function refusalReasons(condition, reading, engineWindows = { c01: reading }) {
  const reasons = [];
  armFor({ delivery: 'host', peerExchange: true, clients: 1 }).refusals({
    condition: { delivery: 'host', peerExchange: true, clients: 1, ...condition },
    declaredClientTags: ['c01'],
    ...(engineWindows === null ? {} : { engineWindows }),
    peerReadings: { c01: { peerExchange: 'on', attribution: 'engine-request', peerId: 'p1' } },
    peerLogHealth: { c01: { missed: 0, reset: false } },
    peerRecords: { c01: [] },
    roomFinal: { counters: { byClient: {}, unattributedMediaBytesDelivered: 0 } },
    originStart: { mediaBytesDelivered: 0, unattributedMediaBytesDelivered: 0 },
    originEnd: { mediaBytesDelivered: 0, unattributedMediaBytesDelivered: 0 },
    linkSamples: [],
  }, (reason, scope, detail) => reasons.push({ reason, scope, detail }));
  return reasons;
}

let product;

export default async function engineWindowsSuite() {
  product = await bundleProductEntry();

  // T1 (design.md D1): re-derived, not deleted. The premise changed — the core no
  // longer builds without window keys when none is supplied; it builds the product's
  // 15/60/60 instead. `__app.engineWindows()` (what the harness supplied) stays null.
  await check('engine-windows (a): absent global publishes null and the core holds the product windows', async () => {
    const page = pageWith();
    await drain();
    assertEqual(json(page.app.engineWindows()), json({ windows: null, error: null }), 'absent global is published as no supplied windows');
    page.open();
    const core = loadEvent(page)?.detail?.p2p?.core;
    assert(core, 'peer load receives a core config');
    assertEqual(core.highDemandTimeWindow, PRODUCT_ENGINE_WINDOWS.highDemandTimeWindow, 'high-demand window defaults to the product set');
    assertEqual(core.httpDownloadTimeWindow, PRODUCT_ENGINE_WINDOWS.httpDownloadTimeWindow, 'HTTP window defaults to the product set');
    assertEqual(core.p2pDownloadTimeWindow, PRODUCT_ENGINE_WINDOWS.p2pDownloadTimeWindow, 'P2P window defaults to the product set');
    // Mutation probe (item 2): `...(windows ?? PRODUCT_ENGINE_WINDOWS)` in
    // peer-engine-config.mjs reverted to `...(windows ?? {})`. `npm run check` turned
    // the three assertions above red — `core.highDemandTimeWindow` read `undefined`
    // against the expected `15`. Reverted; check green again.
  });

  await check('engine-windows (b): supplied windows publish and merge into the peer core', async () => {
    const page = pageWith({ __waEngineWindows: supplied });
    await drain();
    assertEqual(json(page.app.engineWindows()), json({ windows: supplied, error: null }), 'supplied windows are published');
    page.open();
    const core = loadEvent(page)?.detail?.p2p?.core;
    assertEqual(json({
      highDemandTimeWindow: core?.highDemandTimeWindow,
      httpDownloadTimeWindow: core?.httpDownloadTimeWindow,
      p2pDownloadTimeWindow: core?.p2pDownloadTimeWindow,
    }), json(supplied), 'supplied windows reach the engine core');
  });

  await check('engine-windows harness: injection accompanies the offset only when declared', async () => {
    const sent = [];
    const condition = { positionOffsetMsByClient: { c01: 0 }, engineWindows: supplied };
    const options = armFor({ delivery: 'host', peerExchange: true }).prepareClientOptions({ condition, manifestFile: null });
    await options.beforeNavigate({ role: 'viewer', tag: 'c01', tab: { send: async (_method, value) => sent.push(value) } });
    assert(sent[0].source.includes('__waPositionOffsetMs'), 'offset injection is retained');
    assert(sent[0].source.includes('__waEngineWindows'), 'declared windows are injected before navigation');
    const absent = [];
    const noWindows = armFor({ delivery: 'host', peerExchange: true }).prepareClientOptions({
      condition: { positionOffsetMsByClient: { c01: 0 } }, manifestFile: null,
    });
    await noWindows.beforeNavigate({ role: 'viewer', tag: 'c01', tab: { send: async (_method, value) => absent.push(value) } });
    assert(!absent[0].source.includes('__waEngineWindows'), 'undeclared windows are not injected');
  });

  await check('engine-windows (c): every invalid shape names an error and builds no peer engine', async () => {
    const invalid = [
      ['missing key', { highDemandTimeWindow: 15, httpDownloadTimeWindow: 60 }],
      ['extra key', { ...supplied, extra: 1 }],
      ['zero', { ...supplied, httpDownloadTimeWindow: 0 }],
      ['string', { ...supplied, p2pDownloadTimeWindow: '60' }],
      ['high demand above HTTP', { ...supplied, highDemandTimeWindow: 61 }],
    ];
    for (const [label, value] of invalid) {
      const page = pageWith({ __waEngineWindows: value });
      await drain();
      const reading = page.app.engineWindows();
      assert(reading.windows === null && typeof reading.error === 'string', `${label} publishes a named page error`);
      page.open();
      assertEqual(page.events.filter((event) => event.kind === 'load').length, 0, `${label} builds no peer engine`);
    }
    assertEqual(conditionValidationReason({ delivery: 'host', peerExchange: true, clients: 1, engineWindows: invalid[0][1] }),
      'engine-windows-invalid', 'runner rejects invalid condition before clients start');
  });

  await check('engine-windows (d): defaults and supplied values agree with bundled Core read-back', async () => {
    await fs.mkdir(path.dirname(bundlePath), { recursive: true });
    try {
      await esbuild.build({
        absWorkingDir: appDir,
        entryPoints: ['p2p-media-loader-core'],
        bundle: true,
        platform: 'browser',
        format: 'esm',
        outfile: bundlePath,
      });
      const { Core } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
      const defaults = new Core({ swarmId: 'defaults', announceTrackers: [], rtcConfig: { iceServers: [] } }).getConfig().mainStream;
      assertEqual(json({
        highDemandTimeWindow: defaults.highDemandTimeWindow,
        httpDownloadTimeWindow: defaults.httpDownloadTimeWindow,
        p2pDownloadTimeWindow: defaults.p2pDownloadTimeWindow,
      }), json(ENGINE_WINDOW_DEFAULTS), 'ENGINE_WINDOW_DEFAULTS match Core defaults');
      const configured = new Core({ ...supplied, swarmId: 'configured', announceTrackers: [], rtcConfig: { iceServers: [] } }).getConfig().mainStream;
      assertEqual(json({
        highDemandTimeWindow: configured.highDemandTimeWindow,
        httpDownloadTimeWindow: configured.httpDownloadTimeWindow,
        p2pDownloadTimeWindow: configured.p2pDownloadTimeWindow,
      }), json(supplied), 'top-level windows read back under mainStream');
    } finally {
      await fs.rm(bundlePath, { force: true });
    }
  });

  await check('engine-windows (e): a viewer mismatch refuses by tag', async () => {
    const expected = { ...supplied };
    const inForce = { ...supplied, p2pDownloadTimeWindow: 61 };
    const reasons = refusalReasons({ engineWindows: expected }, windowReading({ declared: expected, expected, inForce }));
    const mismatch = reasons.find((entry) => entry.reason === 'engine-windows-mismatch');
    assert(mismatch, 'mismatch is refused');
    assertEqual(mismatch.detail.tag, 'c01', 'mismatch names the viewer');
  });

  await check('engine-windows (f): undeclared conditions expect the product set', async () => {
    // Opportunity: a reading at the library's defaults (15/3000/6000), which is away
    // from the product's, on a condition that declares no windows.
    const reasons = refusalReasons({}, windowReading({ inForce: ENGINE_WINDOW_DEFAULTS }));
    const mismatch = reasons.find((entry) => entry.reason === 'engine-windows-mismatch');
    assert(mismatch, 'a reading at the library defaults is refused when undeclared');
    assertEqual(json(mismatch.detail.expected), json(PRODUCT_ENGINE_WINDOWS), 'undeclared viewer is compared against the product set');
    // The constant's own three values are asserted here too, so a mutation of
    // PRODUCT_ENGINE_WINDOWS itself is caught by this check, not only by identity.
    assertEqual(json(PRODUCT_ENGINE_WINDOWS), json({ highDemandTimeWindow: 15, httpDownloadTimeWindow: 60, p2pDownloadTimeWindow: 60 }),
      'the product set is 15/60/60');
    // Prevention claim — an undeclared condition refuses a page that is not at the
    // product's windows. Mutation: arms.mjs engineWindowRefusals' expected fallback
    // reverted from PRODUCT_ENGINE_WINDOWS to ENGINE_WINDOW_DEFAULTS. `npm run check`
    // turned `assert(mismatch, 'a reading at the library defaults is refused when
    // undeclared')` red: the library-defaults reading now equalled the fallback, so
    // nothing was refused. It also turned the next check ('the expected set comes
    // from the condition...') red the same way. Reverted; check green again.
  });

  await check('engine-windows: the expected set comes from the condition, not the recorded reading', async () => {
    // The recorded reading's own `expected` field claims the product set — a lie the
    // code must not trust — while `inForce` is away from it (the library defaults).
    const lying = windowReading({ expected: PRODUCT_ENGINE_WINDOWS, inForce: ENGINE_WINDOW_DEFAULTS });
    const mismatch = refusalReasons({}, lying).find((entry) => entry.reason === 'engine-windows-mismatch');
    assert(mismatch, 'a reading that records the product set as expected is still refused, on its actual inForce, when the condition declares none');
  });

  await check('engine-windows: evaluated on live evidence, not on directories retained before it existed', async () => {
    const windowReasons = (reasons) => reasons.filter((entry) => entry.reason.startsWith('engine-windows-'));
    assertEqual(windowReasons(refusalReasons({}, null, null)).length, 0, 'no engineWindows evidence object: not evaluated');
    const unread = windowReasons(refusalReasons({}, null, { c01: null }));
    assertEqual(json(unread.map((entry) => [entry.reason, entry.detail.tag])), json([['engine-windows-unavailable', 'c01']]),
      'a live run whose viewer was not read refuses as unavailable');
  });

  await check('engine-windows validator: shape, positivity and ordering are shared', async () => {
    assertEqual(json(validateEngineWindows(supplied)), json({ windows: supplied, error: null }), 'valid shape passes');
    assert(validateEngineWindows(null).error, 'null is rejected');
    assert(validateEngineWindows({ ...supplied, extra: 1 }).error, 'extra key is rejected');
    assert(validateEngineWindows({ ...supplied, highDemandTimeWindow: 0 }).error, 'non-positive value is rejected');
    assert(validateEngineWindows({ ...supplied, highDemandTimeWindow: 61 }).error, 'ordering is rejected');
  });

  await check('engine-windows (T1 2.1 item 5): every peer condition in conditions.json declares windows', async () => {
    const conditionsPath = path.resolve(suiteDir, '../../../harness/conditions.json');
    const conditions = JSON.parse(await fs.readFile(conditionsPath, 'utf8'));
    const undeclared = [];
    // 8b2's conditions run the product's own windows: declaring them is what
    // their product-input refusal refuses, so they must not.
    const productInputs = ['shakedown/control-qual', 'control-five', 'control-ten', 'control-seek', 'sweep-070', 'sweep-095', 'sweep-unpaced',
      // 9b's eleven copy them and run the product's windows as they do.
      'shakedown/edge-qual', 'edge-five', 'edge-ten', 'edge-seek', 'edge-control-ten', 'edge-control-seek', 'edge-drop', 'edge-slow',
      'edge-sweep-070', 'edge-sweep-095', 'edge-sweep-unpaced',
      // 10b's fourteen are edge-five and edge-drop, and judge the product as it ships.
      'baseline-join', 'baseline-leave-clean', 'baseline-leave-silent', 'join', 'leave-clean', 'leave-silent', 'leave-first',
      'drop-socket', 'drop-recover', 'shakedown/churn-join', 'shakedown/churn-leave-clean', 'shakedown/churn-leave-silent',
      'shakedown/churn-drop-socket', 'shakedown/churn-leave-first'];
    // 11a-2's copy 9b's edge conditions and run the product's windows as they do.
    const registeredBy11a2 = (name) => (name.startsWith('11a2-') || name.startsWith('shakedown/11a2-'))
      && name !== '11a2-scattered-4s';
    // 12c-1's copy 11a-2's arms (its executor spec T10).
    const registeredBy12c1 = (name) => name.startsWith('12c1-') || name.startsWith('shakedown/12c1-');
    const registeredBy12c2 = (name) => name.startsWith('12c2-') || name.startsWith('shakedown/12c2-');
    const supplied = [];
    const walk = (group, label) => {
      for (const [name, condition] of Object.entries(group)) {
        if (name === 'schemaVersion' || !condition || typeof condition !== 'object') continue;
        if (condition.peerExchange === true) {
          const declares = Object.prototype.hasOwnProperty.call(condition, 'engineWindows');
          if (productInputs.includes(`${label}${name}`) || registeredBy11a2(`${label}${name}`)
            || registeredBy12c1(`${label}${name}`) || registeredBy12c2(`${label}${name}`)) { if (declares) supplied.push(`${label}${name}`); }
          else if (!declares) undeclared.push(`${label}${name}`);
        } else if (condition.delivery === undefined && !('peerExchange' in condition)
          && Object.values(condition).every((value) => value && typeof value === 'object')) {
          walk(condition, `${label}${name}/`);
        }
      }
    };
    walk(conditions, '');
    assertEqual(json(undeclared), '[]', `every peerExchange condition declares windows; undeclared: ${undeclared.join(', ')}`);
    assertEqual(json(supplied), '[]', `no product-input condition supplies windows; supplied: ${supplied.join(', ')}`);
  });
}
