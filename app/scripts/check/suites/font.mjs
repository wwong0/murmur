// scripts/check/suites/font.mjs — the shipped face, served from this origin (12e design.md D2,
// D3; tasks 2.1, 2.2).

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, assert, assertEqual } from '../harness.mjs';
import { HTTP } from '../fixtures.mjs';
import { tailwindCommand } from '../../build.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FONT_SHA256 = 'aa72922aafcc0dc18f36ec1d805b0212057dabe8b9d5b8b57f67035aea1b826d';
const PATHS = ['/fonts/InstrumentSans[wdth,wght].woff2', '/fonts/InstrumentSans%5Bwdth%2Cwght%5D.woff2'];

export default async function fontSuite() {
  await check('font: the face is served as font/woff2 with the bytes this change shipped, as the stylesheet asks and percent-encoded', async () => {
    for (const urlPath of PATHS) {
      const response = await fetch(`${HTTP}${urlPath}`);
      assertEqual(response.status, 200, `${urlPath} status`);
      assertEqual(response.headers.get('content-type'), 'font/woff2', `${urlPath} content-type`);
      const sha = crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
      assertEqual(sha, FONT_SHA256, `${urlPath} SHA-256`);
    }
  });

  // The stylesheet is built here, to stdout, by the build's own command: the bundle on disk is
  // gitignored and may predate the source, and a stale file must not pass or fail this.
  await check('font: the built stylesheet loads the face from this origin, and the page is named Murmur', async () => {
    const [cli, ...args] = tailwindCommand();
    const outAt = args.indexOf('-o');
    const css = execFileSync(process.execPath, [cli, ...args.slice(0, outAt), ...args.slice(outAt + 2)], { cwd: APP_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const html = fs.readFileSync(path.join(APP_DIR, 'public', 'room.html'), 'utf8');
    assert(/@font-face\s*\{[^}]*font-family:\s*"Instrument Sans"[^}]*url\("\/fonts\/InstrumentSans\[wdth,wght\]\.woff2"\)/.test(css), 'the built stylesheet has the @font-face for /fonts/');
    assert(/--font-sans:\s*"Instrument Sans",/.test(css), '--font-sans leads with the shipped face');
    assert(!/https?:\/\//.test(css), 'the built stylesheet names no http URL');
    assert(!/https?:\/\//.test(html), 'room.html names no http URL');
    assert(html.includes('<title>Murmur</title>'), 'room.html is titled Murmur');
  });
}
