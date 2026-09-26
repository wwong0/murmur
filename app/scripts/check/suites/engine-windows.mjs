import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { ENGINE_WINDOW_DEFAULTS, validateEngineWindows } from '../../../public/lib/engine-windows.mjs';
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

  await check('engine-windows (a): absent global publishes null and leaves core windows absent', async () => {
    const page = pageWith();
    await drain();
    assertEqual(json(page.app.engineWindows()), json({ windows: null, error: null }), 'absent global is published as no supplied windows');
    page.open();
    const core = loadEvent(page)?.detail?.p2p?.core;
    assert(core, 'peer load receives a core config');
    assert(!Object.hasOwn(core, 'highDemandTimeWindow'), 'default high-demand window is not injected');
    assert(!Object.hasOwn(core, 'httpDownloadTimeWindow'), 'default HTTP window is not injected');
    assert(!Object.hasOwn(core, 'p2pDownloadTimeWindow'), 'default P2P window is not injected');
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

  await check('engine-windows (f): undeclared defaults are the expected set', async () => {
    const nonDefault = { ...supplied };
    const reasons = refusalReasons({}, windowReading({ inForce: nonDefault }));
    const mismatch = reasons.find((entry) => entry.reason === 'engine-windows-mismatch');
    assert(mismatch, 'non-default injected windows are refused when undeclared');
    assertEqual(json(mismatch.detail.expected), json(ENGINE_WINDOW_DEFAULTS), 'undeclared viewer is compared against library defaults');
  });

  await check('engine-windows: the expected set comes from the condition, not the recorded reading', async () => {
    const lying = windowReading({ expected: supplied, inForce: supplied });
    const mismatch = refusalReasons({}, lying).find((entry) => entry.reason === 'engine-windows-mismatch');
    assert(mismatch, 'a reading that records 15/60/60 as expected is still refused when the condition declares none');
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
}
