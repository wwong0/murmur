// The run registers a measuring change leaves behind, asserted against the
// results tree rather than remembered.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, assert } from '../harness.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');

// `required`: the change's runs are in this tree, so a missing register is a
// failure, not a vacuous pass.
const REGISTERS = [
  { change: '6a', required: false },
  { change: '6b', required: false },
  { change: '7a2', required: false },
  { change: '7b2', required: true },
  { change: '7c', required: false },
];

export default async function harnessRecordsSuite() {
  for (const { change, required } of REGISTERS) {
    await check(`harness records: every retained ${change} run directory is in the register, and every register entry exists`, async () => {
      const file = path.join(RESULTS_DIR, `RUNS-${change}.json`);
      if (!required && !fs.existsSync(file)) {
        assert(true, `no ${change} register yet — section 8.3 has not run in this tree`);
        return;
      }
      const register = JSON.parse(fs.readFileSync(file, 'utf8'));
      const listed = new Set(register.runs.map((entry) => entry.directory));
      const onDisk = new Set(fs.readdirSync(RESULTS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${change}-`))
        .map((entry) => entry.name));

      // Both directions. A register that only has to be a subset of the tree lets
      // a run be retained and never described, which is the case that makes a
      // later session unable to tell a published baseline from a shakedown.
      for (const name of onDisk) assert(listed.has(name), `retained run ${name} is described in the ${change} register`);
      for (const name of listed) assert(onDisk.has(name), `${change} register entry ${name} names a directory that exists`);
      for (const entry of register.runs) {
        assert(typeof entry.evidenceOf === 'string' && entry.evidenceOf.length > 0, `${entry.directory} says what it is evidence of`);
        assert(entry.publishes === true || entry.publishes === false, `${entry.directory} says whether it publishes`);
        assert(typeof entry.condition === 'string' && entry.condition.length > 0, `${entry.directory} names its condition`);
      }
    });
  }
}
