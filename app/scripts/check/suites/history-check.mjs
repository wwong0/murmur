import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assert, assertEqual, check } from '../harness.mjs';
import { identityCounts, parseTerms, scanPath, scanText } from '../../history-check/scan.mjs';

const script = fileURLToPath(new URL('../../history-check.mjs', import.meta.url));
const terms = parseTerms('# ignored\nOwnerMarkerZ\n');
const secret = 'abcdefghijklmnopQRSTUV0123456789';
const term = 'OwnerMarkerZ';
// The planted profile paths and addresses are put together at run time, so
// this file holds none of them for a scan to find.
const profilePath = (name) => ['C:', 'Users', name, 'file'].join('\\');
const address = (user, domain) => [user, domain].join('@');
const someone = profilePath('someone');
const spaced = profilePath('?lise Example');

function one(label, scan, clean, planted, cls, sub, hidden) {
  assertEqual(scan(clean).hits.length, 0, `${label}: clean`);
  const hits = scan(planted).hits;
  assertEqual(hits.length, 1, `${label}: planted`);
  assertEqual(hits[0].class, cls, `${label}: class`);
  assertEqual(hits[0].sub, sub, `${label}: subclass`);
  assert(!JSON.stringify(hits).includes(hidden), `${label}: masked`);
}

export default async function historyCheckSuite() {
  await check('history check: pure rules detect and mask each planted shape', async () => {
    const text = (input) => scanText(input, terms);
    const pathname = (input) => scanPath(input, 0, terms);
    one('owner term', text, 'ordinary words', `hello ${term}`, 1, 'term', term);
    one('private key', text, 'ordinary words', '-----BEGIN PRIVATE KEY-----', 3, 'private-key', '-----BEGIN PRIVATE KEY-----');
    one('secret assignment', text, 'name=value', `TURN_API_TOKEN=${secret}`, 3, 'assignment', secret);
    one('jwt', text, 'ordinary words', 'eyJabc.eyJdef.signature', 3, 'jwt', 'eyJabc.eyJdef.signature');
    one('uuid', text, 'ordinary words', '12345678-abcd-4321-abcd-123456789abc', 3, 'uuid', '12345678-abcd-4321-abcd-123456789abc');
    one('secret path', pathname, 'docs/readme.txt', 'private/id_ed25519', 3, 'secret-path', 'private/id_ed25519');
    one('room link', text, 'https://example.org/', 'https://example.org/?room=private-room', 4, 'room-link', 'private-room');
    one('media', pathname, 'docs/readme.txt', 'clips/movie.mp4', 5, 'media', 'movie.mp4');
    one('test videos', pathname, 'docs/readme.txt', 'test_videos/hidden.dat', 5, 'test-videos', 'hidden.dat');
    one('over 50MB', (size) => scanPath('docs/data.bin', size), 50_000_000, 50_000_001, 5, 'over-50MB', 'docs/data.bin');
    one('over 100MB', (size) => scanPath('docs/data.bin', size), 50_000_000, 100_000_001, 5, 'over-100MB', 'docs/data.bin');
    assertEqual(scanPath('docs/data.bin', 100_000_000).hits.filter((hit) => hit.sub === 'over-100MB').length, 0, '100MB boundary');
    one('profile', text, 'ordinary words', someone, 6, 'profile', 'someone');
    one('profile with spaces', text, 'ordinary words', spaced, 6, 'profile', '?lise Example');
    one('committed path', pathname, 'docs/readme.txt', '.scratch/note.md', 6, 'committed-path', '.scratch/note.md');
    assertEqual(scanText('https://example.org:8443/').hosts[0], 'example.org:8443', 'host retains port');
    const ids = identityCounts([{ email: address('a', 'example.org') }, { email: address('b', 'example.org') }, { email: address('3+x', 'users.noreply.github.com') }, { email: address('a', 'example.org') }]);
    assertEqual(ids.distinct, 3, 'distinct identities');
    assertEqual(ids.nonNoreply, 2, 'non-noreply identities');
    assert(!JSON.stringify(ids).includes(address('a', 'example.org')), 'identity address masked');
  });

  await check('history check: all history, main split, masking and refusal', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'history-check-'));
    const repo = path.join(temp, 'repo');
    fs.mkdirSync(repo);
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: address('fixture', 'example.org'), GIT_COMMITTER_NAME: 'Fixture Committer', GIT_COMMITTER_EMAIL: address('123+fixture', 'users.noreply.github.com'), GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' }).toString().trim();
    const write = (name, value) => { const target = path.join(repo, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); };
    const commit = (message) => { git('add', '-A'); git('-c', 'commit.gpgsign=false', 'commit', '-m', message); };
    try {
      git('init', '-b', 'main');
      write('readme.txt', 'clean'); write('Fixture Author.txt', 'ordinary'); write(address('contact-a', 'localhost'), 'ordinary'); write('profile.txt', spaced); commit('clean');
      write('deleted.txt', `-----BEGIN PRIVATE KEY-----\nTURN_API_TOKEN=${secret}\n${someone}`);
      write('test_videos/hidden-video.mp4', 'fake media');
      write('.scratch/note.md', 'note');
      for (let i = 0; i < 501; i++) write(`ids/${i}.txt`, `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
      commit(`plant ${term}`);
      fs.unlinkSync(path.join(repo, 'deleted.txt')); commit('delete');
      git('checkout', '-b', 'side');
      write('side.txt', 'https://example.org/?room=private-room\nhttps://example.org/?room=r');
      write('private-room.md', 'ordinary'); commit('side');
      git('checkout', 'main');
      const termFile = path.join(temp, 'terms.txt'), report = path.join(temp, 'report.md'), json = path.join(temp, 'counts.json');
      fs.writeFileSync(termFile, `${term}\n`);
      const result = spawnSync(process.execPath, [script, '--repo', repo, '--report', report, '--terms', termFile, '--json', json], { encoding: 'utf8', env });
      assertEqual(result.status, 0, `CLI completed: ${result.stderr}`);
      const data = JSON.parse(fs.readFileSync(json, 'utf8'));
      const detail = fs.readFileSync(report, 'utf8');
      assertEqual(data.counts[1].all, 1, 'owner term found');
      assertEqual(data.counts[2].all.distinct, 2, 'identity count');
      assert(data.counts[3].main >= 2, 'deleted blob secret assignment and key found');
      assertEqual(data.counts[4].all, 2, 'side branch room links found in all refs');
      assert(detail.includes('Largest blobs on main') && result.stdout.includes('Main commits'), 'a one-letter room value leaves ordinary words intact');
      assertEqual(data.counts[4].main, 0, 'side branch room link excluded from main');
      assert(data.counts[5].main >= 2, 'media and test videos counted');
      assert(data.counts[6].main >= 2, 'profile and committed path counted');
      assert(detail.includes('assignment') && detail.includes('deleted.txt'), 'deleted blob assignment found in report');
      assert(/^- private-key; /m.test(detail) && detail.includes('more uuid rows omitted'), 'a rare sub-class is listed past a capped common one');
      for (const value of [term, secret, '-----BEGIN PRIVATE KEY-----', 'private-room', 'hidden-video.mp4', address('fixture', 'example.org'), address('a', 'localhost'), address('123+fixture', 'users.noreply.github.com'), 'Fixture Author', 'Fixture Committer', '?lise Example', 'someone']) {
        assert(!(detail + result.stdout + fs.readFileSync(json, 'utf8')).includes(value), 'output masks planted value');
      }
      write('terms.txt', term);
      const inside = spawnSync(process.execPath, [script, '--repo', repo, '--report', path.join(temp, 'inside.md'), '--terms', path.join(repo, 'terms.txt')], { encoding: 'utf8', env });
      assertEqual(inside.status, 2, 'terms inside work tree refused');
      const exists = spawnSync(process.execPath, [script, '--repo', repo, '--report', report, '--terms', termFile], { encoding: 'utf8', env });
      assert(exists.status !== 0, 'existing report refused');
      const missing = spawnSync(process.execPath, [script, '--repo', repo, '--report', path.join(temp, 'missing.md'), '--terms', path.join(temp, 'private-room terms file')], { encoding: 'utf8', env });
      assert(missing.status !== 0 && !missing.stderr.includes('private-room'), 'missing terms error masks its path');
      const jsonExists = spawnSync(process.execPath, [script, '--repo', repo, '--report', path.join(temp, 'new.md'), '--json', json], { encoding: 'utf8', env });
      assert(jsonExists.status !== 0 && !fs.existsSync(path.join(temp, 'new.md')), 'existing JSON refused before writing report');
      const emptyRepo = path.join(temp, 'empty');
      fs.mkdirSync(emptyRepo);
      execFileSync('git', ['-C', emptyRepo, 'init', '-b', 'main'], { env, stdio: 'pipe' });
      execFileSync('git', ['-C', emptyRepo, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'empty'], { env, stdio: 'pipe' });
      const emptyResult = spawnSync(process.execPath, [script, '--repo', emptyRepo, '--report', path.join(temp, 'empty.md')], { encoding: 'utf8', env });
      assertEqual(emptyResult.status, 0, 'empty tree scanned');
      assert(emptyResult.stdout.includes('not run (no terms file)'), 'missing terms reported as not run');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
