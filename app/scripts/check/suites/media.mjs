// scripts/check/suites/media.mjs — media serving and path containment.

import path from 'node:path';

import { check, assert, assertEqual, rawGet } from '../harness.mjs';
import { HTTP } from '../fixtures.mjs';

export default async function mediaSuite() {
  await check('media: playlist, init segment and media segment are served with correct types', async () => {
    const playlist = await fetch(`${HTTP}/media/master.m3u8`);
    assertEqual(playlist.status, 200, 'master.m3u8 status');
    assertEqual(playlist.headers.get('content-type'), 'application/vnd.apple.mpegurl', 'master.m3u8 content-type');
    assert((await playlist.text()).startsWith('#EXTM3U'), 'master.m3u8 body should be a playlist');

    const init = await fetch(`${HTTP}/media/init.mp4`);
    assertEqual(init.status, 200, 'init.mp4 status');
    assertEqual(init.headers.get('content-type'), 'video/mp4', 'init.mp4 content-type');
    assertEqual((await init.arrayBuffer()).byteLength, 64, 'init.mp4 length');

    const seg = await fetch(`${HTTP}/media/seg-00000.m4s`);
    assertEqual(seg.status, 200, 'seg-00000.m4s status');
    assertEqual(seg.headers.get('content-type'), 'video/mp4', 'seg-00000.m4s content-type');
    assertEqual((await seg.arrayBuffer()).byteLength, 256, 'seg-00000.m4s length');
  });

  await check('media: a path resolving outside the media root is refused', async () => {
    // 403, not 404. The distinction is the whole assertion: a 404 would mean the
    // request fell through to some other handler and missed the file by luck.
    // Only a 403 proves the containment check itself refused it.
    //
    // Sent over a raw socket, because every ordinary HTTP client resolves dot
    // segments before the request leaves — `fetch` collapses both `../` and its
    // percent-encoded spelling, so a traversal launched through it arrives
    // already harmless and tests nothing. This is the shape of assertion that
    // passes while the guard is broken, which is why it is worth the socket.
    //
    // The backslash spelling is a traversal on WINDOWS ONLY. Under POSIX
    // semantics `..\CLAUDE.md` is a single ordinary filename inside the media
    // root, so the guard rightly admits it and the handler answers 404 — and
    // demanding 403 there fails for a reason that has nothing to do with
    // containment. Change 6 runs this app in Linux containers, and a check that
    // only passes on one platform is a check that stops being run.
    const SEPARATOR_IS_BACKSLASH = path.sep === '\\';
    for (const [attempt, guarded] of [
      ['/media/../outside-the-media-root.txt', true],
      ['/media/%2e%2e/outside-the-media-root.txt', true],
      ['/media/..%2f..%2fCLAUDE.md', true],
      ['/media/..%5cCLAUDE.md', SEPARATOR_IS_BACKSLASH],
    ]) {
      const refused = await rawGet(attempt);
      if (guarded) {
        assertEqual(refused.status, 403, `traversal "${attempt}" must be refused by the containment guard`);
      } else {
        // Not a traversal on this platform, but it must still never serve
        // anything: whatever the spelling means here, the file is not there.
        assert(refused.status !== 200, `"${attempt}" must not be served (got ${refused.status})`);
      }
      assert(!refused.body.includes('must never be served'), 'traversal must not return the file body');
    }

    // ...and the guard did not become so strict that ordinary paths break.
    const ok = await rawGet('/media/seg-00000.m4s');
    assertEqual(ok.status, 200, 'a normal segment still resolves');
  });
}
