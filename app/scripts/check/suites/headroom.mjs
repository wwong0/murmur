// The harness-supplied
// headroom fraction — the page's reading, the harness's injection and refusal,
// and the fraction in force actually driving the host's pace (not merely the
// product default it happens to equal for an undeclared run).

import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { createFakeClock, createFakeLink } from '../fake-channel.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { HEADROOM_DEFAULT, validateHeadroomFraction } from '../../../public/lib/send-pace.mjs';
import { armFor } from '../../harness/arms.mjs';
import { conditionValidationReason } from '../../harness-run.mjs';

const json = (value) => JSON.stringify(value);

async function drain() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function pageWith(globals = {}) {
  return runEntry(product.code, {
    role: 'viewer',
    settings: { delivery: 'host', iceServers: [] },
    globals,
  });
}

function refusalReasons(condition, headroom) {
  const reasons = [];
  armFor({ delivery: 'host', clients: 1 }).refusals({
    condition: { delivery: 'host', clients: 1, ...condition },
    declaredClientTags: ['c01'],
    ...(headroom === undefined ? {} : { headroom }),
    roomFinal: { counters: { byClient: {}, unattributedMediaBytesDelivered: 0 } },
    originStart: { mediaBytesDelivered: 0, unattributedMediaBytesDelivered: 0 },
    originEnd: { mediaBytesDelivered: 0, unattributedMediaBytesDelivered: 0 },
    linkSamples: [],
  }, (reason, scope, detail) => reasons.push({ reason, scope, detail }));
  return reasons;
}

async function hostBeforeNavigateSources(condition) {
  const sent = [];
  await armFor({ delivery: 'host', clients: 1 }).openSessions({
    room: 'r',
    clientOriginUrl: 'http://x',
    clientFactory: async () => ({ tab: { send: async (_method, value) => sent.push(value) } }),
    condition: { delivery: 'host', clients: 1, ...condition },
    runDir: '/tmp',
    deadline: null,
    newSession: (tag, role) => ({ tag, role }),
    prepareHostClient: async (session, url, deadline, options) => { await options.beforeNavigate?.(session); },
  });
  return sent;
}

// A paced host whose three links are individually link-bound, built exactly as
// T3's host-pace.mjs builds one — the smallest rig that lets an estimate form.
async function pacedEstimate(fraction) {
  const clock = createFakeClock();
  const bytes = new Uint8Array(5_000_000);
  const origin = createHostOrigin({ readSource: async () => ({ status: 200, bytes }), clock, pace: { fraction } });
  const links = [0, 1, 2].map(() => createFakeLink({ clock, hostDrainBytesPerMs: 200, viewerDrainBytesPerMs: 1_000_000 }));
  const detaches = links.map((link) => origin.attach(link.host));
  links.forEach((link, index) => link.viewer.send(JSON.stringify({ t: 'req', id: index + 1, path: '/media/big.m4s', range: null })));
  try {
    clock.advance(1);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    clock.advance(5000);
    return origin.pace();
  } finally {
    detaches.forEach((detach) => detach());
    links.forEach((link) => link.closeBoth());
  }
}

let product;

export default async function headroomSuite() {
  product = await bundleProductEntry();

  await check('headroom (a): absent global publishes the product default, unsupplied', async () => {
    const page = pageWith();
    await drain();
    assertEqual(json(page.app.headroom()), json({ fraction: HEADROOM_DEFAULT, supplied: false, error: null }),
      'absent supply is the product default, marked unsupplied');
  });

  await check('headroom (b): valid values (0.7, 1, unpaced) publish exactly what was supplied', async () => {
    for (const value of [0.7, 1, 'unpaced']) {
      const page = pageWith({ __waHeadroomFraction: value });
      await drain();
      assertEqual(json(page.app.headroom()), json({ fraction: value, supplied: true, error: null }), `${value} is published as supplied`);
    }
  });

  await check('headroom (c): invalid values fall back to the product default, supplied and named', async () => {
    for (const value of [0, 1.01, Number.NaN, '0.7', null]) {
      const page = pageWith({ __waHeadroomFraction: value });
      await drain();
      const reading = page.app.headroom();
      assertEqual(reading.fraction, HEADROOM_DEFAULT, `${String(value)} falls back to the product default in force`);
      assertEqual(reading.supplied, true, `${String(value)} was still attempted`);
      assert(typeof reading.error === 'string', `${String(value)} names an error`);
    }
    assertEqual(conditionValidationReason({ delivery: 'host', clients: 1, headroomFraction: 0 }),
      'headroom-fraction-invalid', 'the runner refuses an invalid declared fraction before any client starts');
    // The host still serves at the invalid value's fallback — an invalid supply must
    // not break a room — so the page publishes an error rather than refusing to load.
  });

  await check('headroom harness: injection accompanies the host session only when declared', async () => {
    const declared = await hostBeforeNavigateSources({ headroomFraction: 0.7 });
    assert(declared[0]?.source.includes('globalThis.__waHeadroomFraction = 0.7;'), 'declared fraction is injected before host navigation');
    const absent = await hostBeforeNavigateSources({});
    assertEqual(absent.length, 0, 'undeclared fraction injects nothing before host navigation');
    // Mutation probe: staged, then the `Object.prototype.hasOwnProperty.call(condition,
    // 'headroomFraction')` guard in arms.mjs's HOST_ARM.openSessions dropped, always
    // injecting `undefined`. `npm run check` turned 'undeclared fraction injects
    // nothing' red — `absent.length` read 1 instead of 0. Reverted; check green again.
  });

  await check('headroom harness: the runner\'s two named scenarios', async () => {
    assertEqual(conditionValidationReason({ delivery: 'host', clients: 1, headroomFraction: 0.7 }), null,
      'a valid fraction on a host-delivery condition is accepted');
    assertEqual(conditionValidationReason({ delivery: 'http', clients: 1, headroomFraction: 0.7 }),
      'headroom-fraction-requires-host-delivery', 'a declaration without host delivery is refused');

    const declared = refusalReasons({ headroomFraction: 0.7 }, { fraction: 0.7, supplied: true, pageError: null, available: true });
    assertEqual(declared.filter((entry) => entry.reason.startsWith('headroom-fraction-')).length, 0,
      '0.70 declared and 0.70 published is not refused');

    const mismatched = refusalReasons({}, { fraction: 0.95, supplied: true, pageError: null, available: true });
    const mismatch = mismatched.find((entry) => entry.reason === 'headroom-fraction-mismatch');
    assert(mismatch, 'none declared and 0.95 published is refused');
    assertEqual(mismatch.detail.expected, HEADROOM_DEFAULT, 'the refusal names the product default (0.85) as expected');
    assertEqual(mismatch.detail.published, 0.95, 'the refusal names the published fraction (0.95)');
  });

  await check('headroom harness: invalid and unavailable readings are named, and retained directories are not evaluated', async () => {
    const invalid = refusalReasons({}, { fraction: HEADROOM_DEFAULT, supplied: true, pageError: 'headroom-fraction-must-be-in-(0,1]-or-unpaced', available: true });
    assert(invalid.some((entry) => entry.reason === 'headroom-fraction-invalid'), 'a page error is refused as invalid');

    const unavailable = refusalReasons({}, { fraction: null, supplied: null, pageError: null, available: false });
    assert(unavailable.some((entry) => entry.reason === 'headroom-fraction-unavailable'), 'no reading is refused as unavailable');

    const retained = refusalReasons({}, undefined);
    assertEqual(retained.filter((entry) => entry.reason.startsWith('headroom-fraction-')).length, 0,
      'a directory retained before this change carries no headroom object and is not evaluated');
  });

  await check('headroom: pinned to the fraction in force, not the product default it is not', async () => {
    const result = await pacedEstimate(0.7);
    assert(result.estimate.bytesPerSecond !== null, 'the estimate formed');
    assertEqual(result.fraction, 0.7, 'the fraction in force is what was supplied');
    assertEqual(result.paceBytesPerSecond, 0.7 * result.estimate.bytesPerSecond, 'the published pace is 0.70 × the estimate, not 0.85 × it');
    assert(Math.abs(result.paceBytesPerSecond - HEADROOM_DEFAULT * result.estimate.bytesPerSecond) > 1,
      'the pinned pace is measurably different from what the product default would have produced');
    // Mutation probe: staged, then `pace.fraction ?? HEADROOM_DEFAULT` in
    // host-origin.mjs's createHostOrigin changed to `validateHeadroomFraction(HEADROOM_DEFAULT)`,
    // discarding the supplied fraction outright. `npm run check` turned 'the fraction
    // in force is what was supplied' red — `result.fraction` read 0.85, not 0.70 — and
    // would have turned the 0.70×estimate assertion red as well had it been reached.
    // Reverted; check green again.
  });

  await check('headroom validator: shared with send-pace.mjs, not re-implemented', async () => {
    assertEqual(json(validateHeadroomFraction(0.7)), json({ fraction: 0.7, error: null }), 'a valid fraction passes');
    assert(validateHeadroomFraction(0).error, 'zero is rejected');
    assert(validateHeadroomFraction(1.01).error, 'above one is rejected');
  });
}
