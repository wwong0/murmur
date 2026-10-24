import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertEqual, check } from '../harness.mjs';
import { APP_KEYS, appKeysEqual } from '../../app-shell-keys.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENTRY_PATH = path.join(APP_DIR, 'public', 'room.entry.js');

function staticAppKeys() {
  const source = fs.readFileSync(ENTRY_PATH, 'utf8');
  const start = source.indexOf('window.__app = {');
  const end = source.indexOf('\n};', start);
  if (start === -1 || end === -1) throw new Error('window.__app literal is not statically delimited');
  const body = source.slice(start + 'window.__app = {'.length, end);
  const keys = [];
  for (const line of body.split('\n')) {
    if (!/^ {2}\S/.test(line) || line.trimStart().startsWith('//') || line.trimStart().startsWith('...')) continue;
    const match = line.match(/^ {2}(?:get\s+)?([A-Za-z_$][\w$]*)\s*(?::|\(|,)/);
    if (match) keys.push(match[1]);
  }
  if (keys.length === 0 || new Set(keys).size !== keys.length) throw new Error('window.__app key literal is not statically readable');
  return keys;
}

export default async function appShellKeysSuite() {
  await check('app-shell keys: the predicate is exact in both directions', async () => {
    assert(appKeysEqual([...APP_KEYS]), 'the published keys are accepted');
    for (const key of APP_KEYS) assert(!appKeysEqual(APP_KEYS.filter((candidate) => candidate !== key)), `removing ${key} is rejected`);
    assert(!appKeysEqual([...APP_KEYS, 'unexpected']), 'adding a key is rejected');
  });

  await check('app-shell keys: APP_KEYS equals the static window.__app key set', async () => {
    const actual = staticAppKeys();
    assertEqual([...new Set(actual)].sort().join(','), [...new Set(APP_KEYS)].sort().join(','), 'the static app key set');
    assertEqual(actual.length, APP_KEYS.length, 'the static app key count');
  });
}
