import { check, assert, assertEqual } from '../harness.mjs';
import { trackerArguments } from '../../runner/tracker.mjs';

function normalized(options) {
  const [binary, ...args] = trackerArguments(options);
  return [binary.replaceAll('\\', '/').split('/').slice(-4).join('/'), ...args];
}

export default async function trackerSpawnSuite() {
  await check('tracker spawn: dev, origin and verifier retain their site-specific arguments', async () => {
    const expectedBinary = 'node_modules/bittorrent-tracker/bin/cmd.js';
    const cases = [
      ['dev', { port: 8101, hostname: '127.0.0.1' }, [expectedBinary, '--ws', '--port', '8101', '--http-hostname', '127.0.0.1', '--quiet']],
      ['origin', { port: 8101, hostname: null }, [expectedBinary, '--ws', '--port', '8101', '--quiet']],
      ['verifier', { port: 8127, hostname: '127.0.0.1' }, [expectedBinary, '--ws', '--port', '8127', '--http-hostname', '127.0.0.1', '--quiet']],
    ];
    for (const [site, options, expected] of cases) {
      const actual = normalized(options);
      assert(actual[0] === expectedBinary, `${site} resolves bittorrent-tracker/bin/cmd.js`);
      assertEqual(JSON.stringify(actual), JSON.stringify(expected), `${site} tracker arguments are exact`);
    }
  });
}
