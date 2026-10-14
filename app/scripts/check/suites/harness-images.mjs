import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, assertEqual, check } from '../harness.mjs';
import { buildImages } from '../../harness/images.mjs';
import { buildRefusalDetails, readBundleBuildId } from '../../harness/build-identity.mjs';

// Layer chains: the client image is three layers, an origin adds one to its parent's.
const CLIENT = ['l1', 'l2', 'l3'];
const OLD_CLIENT = ['l1', 'l2', 'old3'];
function fakeDocker({ originOn }) {
  const calls = [];
  const images = {
    'wa6a-client:latest': { Id: 'sha256:client', RootFS: { Layers: CLIENT } },
    'sha256:client': { Id: 'sha256:client', RootFS: { Layers: CLIENT } },
    'sha256:old-client': { Id: 'sha256:old-client', RootFS: { Layers: OLD_CLIENT } },
    'sha256:base': { Id: 'sha256:base', RootFS: { Layers: ['l1'] } },
  };
  const origin = { Id: 'sha256:origin', RootFS: { Layers: [...originOn, 'origin-layer'] } };
  images['wa6a-origin:latest'] = origin;
  images['sha256:origin'] = origin;
  const exec = (argv) => {
    calls.push(argv);
    if (argv[1] === 'image' && argv[2] === 'inspect') return JSON.stringify([images[argv[3]]]);
    if (argv[1] === 'image' && argv[2] === 'ls') return ['sha256:base', 'sha256:origin', 'sha256:old-client', 'sha256:client', ''].join('\n');
    return '';
  };
  return { calls, exec };
}

export default async function harnessImagesSuite() {
  await check('harness images: stale origin parent names both image ids', async () => {
    const fake = fakeDocker({ originOn: OLD_CLIENT });
    let failure;
    try { buildImages({ exec: fake.exec }); } catch (error) { failure = error; }
    assert(failure, 'stale parent is rejected');
    assert(failure.message.includes('sha256:old-client'), 'stale parent id is named');
    assert(failure.message.includes('sha256:client'), 'new client id is named');
  });

  await check('harness images: matching origin parent returns all three ids', async () => {
    const fake = fakeDocker({ originOn: CLIENT });
    assertEqual(JSON.stringify(buildImages({ exec: fake.exec })), JSON.stringify({
      client: 'sha256:client', origin: 'sha256:origin', originParent: 'sha256:client',
    }), 'matching parent is returned');
    const builds = fake.calls.filter((argv) => argv[1] === 'compose' && argv.includes('build'));
    assertEqual(builds[0].at(-1), 'c01', 'client image builds first');
    assertEqual(builds[1].at(-1), 'origin', 'origin image builds second');
  });

  await check('harness images: build identity refuses each mismatched pair', async () => {
    const details = buildRefusalDetails({
      host: 'build-a', viewers: { c01: 'build-a', c02: 'build-b' }, disk: 'build-a',
    });
    assert(details.some((detail) => detail.pair === 'host-viewer' && detail.viewer === 'c02'), 'host-viewer pair is named');
    assert(details.some((detail) => detail.pair === 'viewer-disk' && detail.viewer === 'c02'), 'viewer-disk pair is named');
    assertEqual(buildRefusalDetails({ host: 'build-a', viewers: { c01: 'build-a' }, disk: 'build-a' }).length, 0,
      'matching host, viewer and disk are accepted');
    assert(buildRefusalDetails({ host: null, viewers: { c01: 'build-a' }, disk: 'build-a' })
      .some((detail) => detail.pair === 'host-viewer'), 'null host id is refused as host-viewer');
  });

  await check('harness images: the bundle build id is read from the file, and a missing file reads none', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bundle-'));
    try {
      const file = path.join(dir, 'room.bundle.js');
      fs.writeFileSync(file, ['(() => {', '  var BUILD_ID = "2026-10-11T11:22:18.453Z-9b4dc4";', '  console.log(BUILD_ID);', '})();', ''].join('\n'));
      assertEqual(readBundleBuildId(file), '2026-10-11T11:22:18.453Z-9b4dc4', 'the id esbuild inlines');
      assertEqual(readBundleBuildId(path.join(dir, 'absent.js')), null, 'no file, no id');
      assert(buildRefusalDetails({ host: 'a', viewers: { c01: 'a' }, disk: null })
        .some((detail) => detail.pair === 'host-disk'), 'a null disk id is refused as host-disk');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
