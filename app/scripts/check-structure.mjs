// scripts/check-structure.mjs
//
// Build-time structural linter. Enforces five rules that keep the app's
// architecture honest without a real parser — deliberately dumb regex/
// substring scans over the source tree, so this file stays auditable no
// matter how many changes land on top of it. Run via `npm run build` /
// `npm run check` (see package.json); exits 1 and prints every violation
// found (not just the first) if anything trips, exits 0 with a short
// summary otherwise.
//
// The five rules (see PLAN.md / CLAUDE.md for the "why"):
//   1. No non-empty inline <script> in app/public/**/*.html — pages are
//      shells, all behaviour lives in bundled modules.
//   1b. Each page has one bundled script and at most one bundled stylesheet.
//   2. DOM access (document./location./bare window.) only in
//      public/room.entry.js and the component tree public/room/**; never in
//      public/lib/**, whose modules take config as arguments (design.md D3).
//   3. The string "payload" must never appear under app/server/** — the
//      routing server is structurally forbidden from naming the
//      message-content field, which is how it's kept from interpreting
//      messages it only routes.
//   4. A source file must not carry more prose than rule 4's threshold
//      allows — the one rule here that is a floor rather than an absolute,
//      and the only one that can be satisfied by deleting rather than
//      moving something.
//
// Node 24, ESM, node:fs + node:path only. Paths are resolved relative to
// this script's own location (import.meta.url), not the cwd, so `npm run
// build` works the same from any directory.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(APP_DIR, '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const LIB_DIR = path.join(PUBLIC_DIR, 'lib');
const SERVER_DIR = path.join(APP_DIR, 'server');

/**
 * Recursively list files under `dir` whose path satisfies `filter(absPath)`.
 * Skips node_modules and any *.bundle.js (generated output, not source).
 * Returns [] if `dir` doesn't exist yet — rules must not crash on a tree
 * that's still being scaffolded by a parallel worker.
 */
function walk(dir, filter, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, filter, out);
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.bundle.js')) continue;
      if (filter(full)) out.push(full);
    }
  }
  return out;
}

/** Path printed in violation messages: relative to APP_DIR's parent (repo root-ish), forward slashes. */
function displayPath(absPath) {
  return path.relative(APP_DIR, absPath).split(path.sep).join('/');
}

const violations = []; // { file, line, text, rule }
const warnings = []; // same shape; reported but never fatal — see rule 4

function addViolation(file, lineNumber, lineText, rule) {
  violations.push({ file, line: lineNumber, text: lineText.trim(), rule });
}

function addWarning(file, lineNumber, lineText, rule) {
  warnings.push({ file, line: lineNumber, text: lineText.trim(), rule });
}

// ---------------------------------------------------------------------------
// Rule 1: no non-empty inline <script> in app/public/**/*.html
// ---------------------------------------------------------------------------

/**
 * Scan one HTML file for <script>...</script> blocks whose body is anything
 * other than whitespace or HTML/JS comments. `<script src="...">` with an
 * empty body is fine (that's how the bundle gets loaded). Regex-based on
 * purpose: this rule is meant to be dumb and obvious, not a real HTML parser.
 */
function checkHtmlFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(text)) !== null) {
    const body = match[2];
    // Strip JS-style comments before checking for meaningful content.
    const stripped = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .trim();
    if (stripped === '') continue; // empty or comment-only body: fine

    const lineNumber = text.slice(0, match.index).split('\n').length;
    const firstLine = match[0].split('\n')[0];
    addViolation(file, lineNumber, firstLine, 'rule 1: non-empty inline <script> (pages must be shells; put behaviour in a bundled module)');
  }

  const scripts = [...text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)];
  if (scripts.length !== 1) {
    addViolation(file, 1, `<script src> count: ${scripts.length}`, 'rule 1b: each page must have exactly one script src ending in .bundle.js');
  } else if (!scripts[0][1].endsWith('.bundle.js')) {
    addViolation(file, 1, `<script src> count: ${scripts.length}`, 'rule 1b: the page script src must end in .bundle.js');
  }

  const stylesheets = [...text.matchAll(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi)];
  if (stylesheets.length > 1) {
    addViolation(file, 1, `<link rel="stylesheet"> count: ${stylesheets.length}`, 'rule 1b: each page may have at most one stylesheet link');
  } else if (stylesheets.length === 1) {
    const href = stylesheets[0][0].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? '';
    if (!href.endsWith('.bundle.css')) {
      addViolation(file, 1, `<link rel="stylesheet"> count: ${stylesheets.length}`, 'rule 1b: the stylesheet href must end in .bundle.css');
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 2: no DOM access under app/public/lib/**
// ---------------------------------------------------------------------------

const DOM_ACCESS_RE = /\bdocument\.|\blocation\.|(?<![\w.])window\./;

/**
 * Scan one lib file line by line for document./location./bare window. Bare
 * window. means "window." not preceded by a `.` or word char (so `foo.window.`
 * as a property path doesn't false-positive, though that's an edge case —
 * the rule is deliberately dumb per spec).
 */
const ENTRY_FILE = path.join(PUBLIC_DIR, 'room.entry.js');
const ROOM_DIR = path.join(PUBLIC_DIR, 'room');

function checkDomFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    if (DOM_ACCESS_RE.test(line)) {
      const inLib = file.startsWith(`${LIB_DIR}${path.sep}`);
      const allowed = file === ENTRY_FILE || file.startsWith(`${ROOM_DIR}${path.sep}`);
      if (!inLib && !allowed) {
        addViolation(file, idx + 1, line, 'rule 2: DOM access outside the entry and the component tree (public/room.entry.js, public/room/**)');
        return;
      }
      if (!inLib) return;
      addViolation(file, idx + 1, line, 'rule 2: DOM access (document./location./window.) is forbidden under public/lib/** — modules must take config as arguments');
    }
  });
}

// ---------------------------------------------------------------------------
// Rule 3: "payload" must not appear anywhere under app/server/**
// ---------------------------------------------------------------------------

function checkServerFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('payload')) {
      addViolation(file, idx + 1, line, 'rule 3: "payload" must never appear under server/** — the server must not name the message-content field');
    }
  });
}

// ---------------------------------------------------------------------------
// Rule 4: prose must not outgrow code
// ---------------------------------------------------------------------------

/**
 * A FLOOR, NOT A STANDARD. Counting lines cannot tell a trap from an essay, and
 * this rule does not try: it catches sprawl, and the session D review does the
 * judgement (WORKFLOW.md). It exists because CONSTRAINTS.md → *Artifacts* has
 * carried the rule in prose since change 1 and nothing enforced it, which is how
 * three files reached more comment lines than code lines without anyone noticing.
 *
 * MAX_PROSE_RATIO is derived, not chosen, and is DELIBERATELY LOOSER THAN THE
 * NORM. CONSTRAINTS.md puts the house style at ~0.6; measured on 2026-08-22 the
 * app's files clustered at 0.73 and below with four outliers at 1.12 and above,
 * and the threshold sits in that gap. A gate set at the norm would police style
 * and start deleting traps worth keeping; set here it only catches sprawl.
 *
 * MIN_CODE_LINES exists because a short file with an ordinary header block is
 * legitimately prose-heavy and says nothing about the codebase's health. It is
 * 60 rather than 80 because 80 let a 77-line offender through.
 *
 * What a violation means: the comments are re-arguing decisions that belong in a
 * change's design.md, which is archived and immutable where a comment is neither.
 * Keep the trap ("stamp t1 here or queueing delay enters the estimate") and the
 * pointer ("clock-sync design.md D7"); cut the alternatives-considered.
 */
const MAX_PROSE_RATIO = 0.9;
const MIN_CODE_LINES = 60;

/** Blank lines count as neither. A line inside a block comment counts as prose. */
function proseRatio(text) {
  let prose = 0;
  let code = 0;
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (inBlock) {
      prose += 1;
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*')) {
      prose += 1;
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//')) prose += 1;
    else code += 1;
  }
  return { prose, code, ratio: code === 0 ? 0 : prose / code };
}

function checkProse(file) {
  const { prose, code, ratio } = proseRatio(fs.readFileSync(file, 'utf8'));
  if (code < MIN_CODE_LINES || ratio <= MAX_PROSE_RATIO) return;
  addWarning(
    file,
    1,
    `${prose} prose lines against ${code} of code`,
    `rule 4: prose ratio ${ratio.toFixed(2)} exceeds ${MAX_PROSE_RATIO} — comments are re-arguing decisions that belong in the change's design.md (CONSTRAINTS.md → *Artifacts*)`
  );
}

// ---------------------------------------------------------------------------
// --ratios: rule 4's measurement without rule 4's floor
// ---------------------------------------------------------------------------

/**
 * Session D3 is required to compute the prose ratio over the files in the diff
 * (CONSTRAINTS.md → *Artifacts*), and MIN_CODE_LINES suppresses exactly the files
 * that requirement exists for: change 3a shipped room-timeline.mjs at 1.32 —
 * 66 prose lines against 50 of code — with the gate reporting nothing, because
 * 50 is under the floor. So the check that runs on every build cannot be the
 * one D3 relies on.
 *
 * Reports, never fails. There is no threshold here on purpose: a number D3 is
 * handed and must judge is the point, and a second gate would only teach the
 * same lesson rule 4 already teaches about deleting to satisfy a counter.
 */
const RATIOS_RANGE = 'main...HEAD'; // the range D3 reviews; the label below must not drift from it

function reportRatios() {
  let files;
  let scope;
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=d', RATIOS_RANGE], {
      cwd: APP_DIR,
      encoding: 'utf8',
    });
    files = out.split('\n').filter(Boolean);
    scope = `git diff ${RATIOS_RANGE}`;
  } catch {
    files = [];
    scope = null;
  }

  // On main, or with no source in the diff, measure everything rule 4 scans.
  // An empty report reads as "nothing is over the line" when it means "nothing
  // was looked at", which is the failure this whole mode exists to prevent.
  const isSource = (f) => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.jsx');
  let paths = files
    .filter(isSource)
    .filter((f) => !f.endsWith('.bundle.js'))
    .map((f) => path.resolve(REPO_DIR, f))
    .filter((f) => fs.existsSync(f));
  if (paths.length === 0) {
    paths = [
      ...walk(PUBLIC_DIR, isSource),
      ...walk(SERVER_DIR, isSource),
      ...walk(path.join(APP_DIR, 'scripts'), isSource),
    ];
    scope = scope === null ? 'whole tree (no git)' : 'whole tree (no source in diff)';
  }

  const rows = paths
    .map((file) => ({ file, ...proseRatio(fs.readFileSync(file, 'utf8')) }))
    .sort((a, b) => b.ratio - a.ratio);

  console.log(`[ratios] ${rows.length} source file(s), scope: ${scope}`);
  console.log(`[ratios] house style ~0.6; rule 4 warns above ${MAX_PROSE_RATIO} and only at ${MIN_CODE_LINES}+ lines of code`);
  for (const r of rows) {
    const flag = r.ratio > MAX_PROSE_RATIO ? (r.code < MIN_CODE_LINES ? ' <- over, and under rule 4 floor' : ' <- over') : '';
    console.log(`  ${r.ratio.toFixed(2)}  ${String(r.prose).padStart(4)} prose /${String(r.code).padStart(5)} code  ${displayPath(r.file)}${flag}`);
  }
  process.exit(0);
}

if (process.argv.includes('--ratios')) reportRatios();

// ---------------------------------------------------------------------------
// Run all four rules
// ---------------------------------------------------------------------------

const htmlFiles = walk(PUBLIC_DIR, (f) => f.toLowerCase().endsWith('.html'));
for (const file of htmlFiles) checkHtmlFile(file);

const publicSourceFiles = walk(PUBLIC_DIR, (f) => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.jsx'));
for (const file of publicSourceFiles) checkDomFile(file);

const serverFiles = walk(SERVER_DIR, () => true);
for (const file of serverFiles) checkServerFile(file);

const isSource = (f) => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.jsx');
const proseFiles = [
  ...walk(PUBLIC_DIR, isSource),
  ...walk(SERVER_DIR, isSource),
  ...walk(path.join(APP_DIR, 'scripts'), isSource),
];
for (const file of proseFiles) checkProse(file);

// WARNINGS DO NOT FAIL THE BUILD. Rule 4 is a judgement about prose, and a
// judgement a line-counter cannot actually make: it cannot tell a trap worth
// keeping from an essay that belongs in a design.md, so it must not be able to
// stop anyone working. It is here to be visible on every run and to be acted on
// by the session D review, not to be satisfied in a hurry by deleting whatever
// makes the number go down.
for (const w of warnings) {
  console.warn(`${displayPath(w.file)}:${w.line}: ${w.text}`);
  console.warn(`  -> ${w.rule}`);
}

if (violations.length > 0) {
  for (const v of violations) {
    console.error(`${displayPath(v.file)}:${v.line}: ${v.text}`);
    console.error(`  -> ${v.rule}`);
  }
  console.error(`[check-structure] FAILED: ${violations.length} violation(s) found`);
  process.exit(1);
} else {
  const warned = warnings.length > 0 ? `, ${warnings.length} prose warning(s)` : '';
  console.log(`[check-structure] OK: scanned ${htmlFiles.length} HTML file(s), ${publicSourceFiles.length} public source file(s), ${serverFiles.length} server file(s), ${proseFiles.length} source file(s) for prose ratio, no violations${warned}`);
  process.exit(0);
}
