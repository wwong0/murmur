// The records this change is required to leave behind, asserted rather than
// remembered (tasks.md §8).
//
// Two of them are about files nobody may write and a register nobody may let
// drift, so they are checked against git and the results tree rather than
// against a fixture. This is the one suite here that shells out; it reads and
// never writes, and `git log --name-only` over a branch of a few dozen commits
// costs milliseconds.
//
// Outside a git work tree — an exported tarball, a fresh unpacked copy — the
// history assertion has nothing to read. It says so and passes, because a rule
// about what the branch's commits contain cannot be evaluated where there are
// no commits, and a check that fails for being unable to look is a check people
// learn to ignore.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, assert, assertEqual } from '../harness.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO_DIR = path.resolve(APP_DIR, '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const REGISTER = path.join(RESULTS_DIR, 'RUNS-6a.json');

// OQ5's owner writes this file. No stage of this change may, and the rule is
// worth an assertion because the temptation is strongest at the end, when the
// harness has entry points and settings that look like they belong in it.
const FORBIDDEN = 'app/CLAUDE.md';

function git(args) {
  return execFileSync('git', args, { cwd: REPO_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function branchFiles() {
  try {
    git(['rev-parse', '--git-dir']);
  } catch {
    return null;
  }
  // `main...HEAD` and not `main..HEAD`: the two-dot form re-reports every file
  // main has moved on to since this branch left it, which is not this branch's
  // doing and would make the assertion fail for someone else's commit.
  const text = git(['log', '--name-only', '--format=', 'main...HEAD']);
  return new Set(text.split('\n').map((line) => line.trim()).filter(Boolean));
}

export default async function harnessRecordsSuite() {
  await check('harness records: no commit on this branch touches app/CLAUDE.md', async () => {
    const files = branchFiles();
    if (files === null) {
      assert(true, 'not a git work tree — the branch history cannot be read and the rule is not evaluated here');
      return;
    }
    assert(files.size > 0, 'the branch has commits to check, so a pass means the file was absent and not that nothing was read');
    assertEqual(files.has(FORBIDDEN), false, `${FORBIDDEN} is OQ5's owner's and no stage of this change may write it`);
  });

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
}
