import { naiveMeasurement } from '../../figures/p2p-measurement.mjs';
import { probePathsFromContainers } from '../../harness/topology.mjs';
import { conditions } from '../../harness-run.mjs';
import { assert, assertEqual, check } from '../harness.mjs';

const IMAGES = { origin: 'origin-a', client: 'client-a' };
const TAGS = ['c01', 'c02'];

function manifest(name, overrides = {}) {
  return {
    condition: { name, bars: name === 'p2p-scattered' ? { controlFloorMin: 0.5 } : {} },
    status: 'complete',
    outcome: 'pass',
    regime: { images: { ...IMAGES } },
    declaredClientTags: TAGS,
    clients: Object.fromEntries(TAGS.map((tag) => [tag, { role: 'viewer', buildId: 'build-a' }])),
    ...overrides,
  };
}

function run(name, figures = {}, overrides = {}) {
  return {
    report: {
      figures: { peerFractionAggregate: 0.7, hostUploadMultiplier: 2, ...figures },
      publishedByte: {},
      ...overrides.report,
    },
    manifest: manifest(name, overrides.manifest),
  };
}

function green() {
  return {
    control: run('p2p-scattered', { peerFractionAggregate: 0.5 }),
    naive: [run('p2p-naive'), run('p2p-naive'), run('p2p-naive')],
  };
}

function result(overrides = {}) {
  const value = green();
  return naiveMeasurement({ ...value, ...overrides });
}

export default async function p2pMeasurementSuite() {
  await check('p2p measurement: the accepted gate returns nearest-rank figures and reading', async () => {
    const value = result();
    assertEqual(value.published, true, 'the scattered control clears its floor');
    assertEqual(value.controlAggregate, 0.5, 'the control aggregate is retained');
    assertEqual(value.medians.peerFractionAggregate, 0.7, 'the naive aggregate median is nearest-rank');
    assertEqual(value.medians.hostUploadMultiplier, 2, 'the naive multiplier median is nearest-rank');
    assertEqual(value.reading, 'strong', 'the registered reading is strong');
    assertEqual(value.figures.naive.length, 3, 'all three naive run figures are retained');
  });

  await check('p2p measurement: each withholding reason is independently named', async () => {
    const below = result({ control: run('p2p-scattered', { peerFractionAggregate: 0.4999 }) });
    const edge = result({ control: run('p2p-scattered', { peerFractionAggregate: 0.5 }) });
    assertEqual(JSON.stringify(below.reasons), JSON.stringify(['control-below-floor']), '0.4999 is below the floor');
    assertEqual(edge.published, true, '0.5000 is the control edge');

    const imageCase = green();
    imageCase.control.manifest.regime.images.origin = 'origin-b';
    assertEqual(JSON.stringify(result({ control: imageCase.control }).reasons), JSON.stringify(['images-mismatch']), 'another image digest withholds publication');

    assertEqual(JSON.stringify(result({ naive: green().naive.slice(0, 2) }).reasons), JSON.stringify(['naive-run-count']), 'two naive runs are not enough');

    const refused = run('p2p-naive', {}, { report: { refusal: { refused: true, runRefused: true } } });
    assertEqual(JSON.stringify(result({ naive: [run('p2p-naive'), refused, run('p2p-naive')] }).reasons), JSON.stringify(['naive-refused']), 'a refused naive run is withheld');

    const buildCase = green();
    buildCase.naive[0].manifest.clients.c01.buildId = 'build-b';
    assertEqual(JSON.stringify(result({ control: buildCase.control, naive: buildCase.naive }).reasons), JSON.stringify(['build-mismatch']), 'another viewer build is withheld');

    const controlRefused = run('p2p-scattered', { peerFractionAggregate: 0.5 }, { manifest: { status: 'refused', outcome: 'refused', refusalReasons: ['constructed'] } });
    assertEqual(JSON.stringify(result({ control: controlRefused }).reasons), JSON.stringify(['control-refused']), 'a retained refused control is withheld');
    assertEqual(JSON.stringify(result({ control: null }).reasons), JSON.stringify(['control-missing']), 'a missing control is withheld');
  });

  await check('p2p measurement: the reading is registered before the data', async () => {
    const strongFraction = naiveMeasurement({
      control: run('p2p-scattered', { peerFractionAggregate: 0.5 }),
      naive: [run('p2p-naive', { peerFractionAggregate: 0.59 }), run('p2p-naive', { peerFractionAggregate: 0.61 }), run('p2p-naive', { peerFractionAggregate: 0.62 })],
    });
    assertEqual(strongFraction.reading, 'strong', '0.59, 0.61, 0.62 reads strong');

    const poor = naiveMeasurement({
      control: run('p2p-scattered', { peerFractionAggregate: 0.5 }),
      naive: [run('p2p-naive', { peerFractionAggregate: 0.59, hostUploadMultiplier: 1.6 }), run('p2p-naive', { peerFractionAggregate: 0.59, hostUploadMultiplier: 1.6 }), run('p2p-naive', { peerFractionAggregate: 0.61, hostUploadMultiplier: 1.6 })],
    });
    assertEqual(poor.reading, 'poor', '0.59, 0.59, 0.61 with 1.6 multipliers reads poor');

    const strongMultiplier = naiveMeasurement({
      control: run('p2p-scattered', { peerFractionAggregate: 0.5 }),
      naive: [run('p2p-naive', { peerFractionAggregate: 0.59, hostUploadMultiplier: 1.4 }), run('p2p-naive', { peerFractionAggregate: 0.59, hostUploadMultiplier: 1.5 }), run('p2p-naive', { peerFractionAggregate: 0.61, hostUploadMultiplier: 1.6 })],
    });
    assertEqual(strongMultiplier.medians.hostUploadMultiplier, 1.5, 'the multiplier median is nearest-rank');
    assertEqual(strongMultiplier.reading, 'strong', 'a 1.5 multiplier reads strong');
  });

  await check('p2p measurement: refusal fallback and publication shape are fail-closed', async () => {
    const fallback = run('p2p-naive', {}, { manifest: { status: 'refused', outcome: 'refused', refusalReasons: ['retained'] } });
    assertEqual(JSON.stringify(result({ naive: [run('p2p-naive'), fallback, run('p2p-naive')] }).reasons), JSON.stringify(['naive-refused']), 'manifest refusal fields are used when evaluation is absent');
    const unpublished = run('p2p-naive', {}, { report: { publishedByte: { published: false, missing: 'constructed' } } });
    assertEqual(JSON.stringify(result({ naive: [run('p2p-naive'), unpublished, run('p2p-naive')] }).reasons), JSON.stringify(['naive-refused']), 'an unpublished byte figure is refused');
  });

  await check('p2p measurement: topology identifies the shaped clock path', async () => {
    const paths = probePathsFromContainers({ origin: 'origin-container', c01: 'client-1', c02: 'client-2', c03: 'client-3', c04: 'client-4', c05: 'client-5' }, { delivery: 'host', clients: 5 });
    assertEqual(paths.c00.clockProbesCrossShapedUplink, false, 'c00 is in the origin container');
    for (const tag of ['c01', 'c02', 'c03', 'c04', 'c05']) assertEqual(paths[tag].clockProbesCrossShapedUplink, true, `${tag} crosses the shaped uplink`);
    assert(Object.values(paths).every((path) => path.peerLinksShaped === false), 'peer links are not claimed shaped');
    assert(!('figureKinds' in conditions['p2p-scattered']) || !conditions['p2p-scattered'].figureKinds.includes('drift'), 'p2p-scattered publishes no pairwise drift');
  });
}
