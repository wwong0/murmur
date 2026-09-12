// scripts/check/supervisor-cli-overrides.mjs
//
// The one module the supervisor command's `--test-overrides=` seam accepts, used
// by product-integration-supervisor's subprocess check. It reads its settings
// from PRODUCT_INTEGRATION_TEST and puts check/fake-verifier.mjs where the real
// verifier goes, so the command itself can be exercised end to end — including
// its exit — without a build and without Chrome.

import { fileURLToPath } from 'node:url';

const FAKE_VERIFIER = fileURLToPath(new URL('./fake-verifier.mjs', import.meta.url));

export default function testOverrides() {
  const config = JSON.parse(process.env.PRODUCT_INTEGRATION_TEST ?? '{}');
  const overrides = {
    resultsDir: config.resultsDir,
    wallMs: config.wallMs,
    bytesBound: config.bytesBound,
    cleanupReserveMs: config.cleanupReserveMs,
    killGraceMs: config.killGraceMs,
    monitorMs: config.monitorMs,
    appPort: config.appPort,
    debugPort: config.debugPort,
    checks: async () => ({ ok: true, stops: [] }),
    build: async () => ({ ok: true, steps: [], bundleSha256: 'fixture' }),
    verifierArgs: (verifierDir) => [
      process.execPath,
      FAKE_VERIFIER,
      `--run-dir=${verifierDir}`,
      `--mode=${config.mode}`,
      `--template=${config.template}`,
      `--pid-file=${config.pidFile}`,
    ],
  };
  if (config.refuseTermination) overrides.terminate = () => 'refused-by-test';
  return overrides;
}
