// The run registers changes 6a, 6b and 7a2 are required to leave behind,
// asserted against the results tree rather than remembered.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, assert } from '../harness.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const REGISTER = path.join(RESULTS_DIR, 'RUNS-6a.json');
const REGISTER_6B = path.join(RESULTS_DIR, 'RUNS-6b.json');
const REGISTER_7A2 = path.join(RESULTS_DIR, 'RUNS-7a2.json');
const REGISTER_7B2 = path.join(RESULTS_DIR, 'RUNS-7b2.json');

export default async function harnessRecordsSuite() {
  await check('harness records: every retained 6a run directory is in the register, and every register entry exists', async () => {
    if (!fs.existsSync(REGISTER)) {
      assert(true, 'no register yet — section 8.3 has not run in this tree');
      return;
    }
    const register = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));
    const listed = new Set(register.runs.map((entry) => entry.directory));
    const onDisk = new Set(fs.readdirSync(RESULTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('6a-'))
      .map((entry) => entry.name));

    // Both directions. A register that only has to be a subset of the tree lets
    // a run be retained and never described, which is the case that makes a
    // later session unable to tell a published baseline from a shakedown.
    for (const name of onDisk) assert(listed.has(name), `retained run ${name} is described in the register`);
    for (const name of listed) assert(onDisk.has(name), `register entry ${name} names a directory that exists`);

    for (const entry of register.runs) {
      assert(typeof entry.evidenceOf === 'string' && entry.evidenceOf.length > 0, `${entry.directory} says what it is evidence of`);
      assert(entry.publishes === true || entry.publishes === false, `${entry.directory} says whether it publishes`);
      assert(typeof entry.condition === 'string' && entry.condition.length > 0, `${entry.directory} names its condition`);
    }
  });

  await check('harness records: every retained 6b run directory is in the register, and every register entry exists', async () => {
    if (!fs.existsSync(REGISTER_6B)) {
      assert(true, 'no 6b register yet — section 8.3 has not run in this tree');
      return;
    }
    const register = JSON.parse(fs.readFileSync(REGISTER_6B, 'utf8'));
    const listed = new Set(register.runs.map((entry) => entry.directory));
    const onDisk = new Set(fs.readdirSync(RESULTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('6b-'))
      .map((entry) => entry.name));
    for (const name of onDisk) assert(listed.has(name), `retained run ${name} is described in the 6b register`);
    for (const name of listed) assert(onDisk.has(name), `6b register entry ${name} names a directory that exists`);
    for (const entry of register.runs) {
      assert(typeof entry.evidenceOf === 'string' && entry.evidenceOf.length > 0, `${entry.directory} says what it is evidence of`);
      assert(entry.publishes === true || entry.publishes === false, `${entry.directory} says whether it publishes`);
      assert(typeof entry.condition === 'string' && entry.condition.length > 0, `${entry.directory} names its condition`);
    }
  });

  await check('harness records: every retained 7a2 run directory is in the register, and every register entry exists', async () => {
    if (!fs.existsSync(REGISTER_7A2)) {
      assert(true, 'no 7a2 register yet â€” section 8.3 has not run in this tree');
      return;
    }
    const register = JSON.parse(fs.readFileSync(REGISTER_7A2, 'utf8'));
    const listed = new Set(register.runs.map((entry) => entry.directory));
    const onDisk = new Set(fs.readdirSync(RESULTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('7a2-'))
      .map((entry) => entry.name));
    for (const name of onDisk) assert(listed.has(name), `retained run ${name} is described in the 7a2 register`);
    for (const name of listed) assert(onDisk.has(name), `7a2 register entry ${name} names a directory that exists`);
    for (const entry of register.runs) {
      assert(typeof entry.evidenceOf === 'string' && entry.evidenceOf.length > 0, `${entry.directory} says what it is evidence of`);
      assert(entry.publishes === true || entry.publishes === false, `${entry.directory} says whether it publishes`);
      assert(typeof entry.condition === 'string' && entry.condition.length > 0, `${entry.directory} names its condition`);
    }
  });

  await check('harness records: every retained 7b2 run directory is in the register, and every register entry exists', async () => {
    // T8 has run in this tree, so a missing register is a failure, not a vacuous pass.
    const register = JSON.parse(fs.readFileSync(REGISTER_7B2, 'utf8'));
    const listed = new Set(register.runs.map((entry) => entry.directory));
    const onDisk = new Set(fs.readdirSync(RESULTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('7b2-'))
      .map((entry) => entry.name));
    for (const name of onDisk) assert(listed.has(name), `retained run ${name} is described in the 7b2 register`);
    for (const name of listed) assert(onDisk.has(name), `7b2 register entry ${name} names a directory that exists`);
    for (const entry of register.runs) {
      assert(typeof entry.evidenceOf === 'string' && entry.evidenceOf.length > 0, `${entry.directory} says what it is evidence of`);
      assert(entry.publishes === true || entry.publishes === false, `${entry.directory} says whether it publishes`);
      assert(typeof entry.condition === 'string' && entry.condition.length > 0, `${entry.directory} names its condition`);
    }
  });
}
