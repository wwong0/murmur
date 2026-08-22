// scripts/check-structure.mjs
//
// Build-time structural linter. Enforces four rules that keep the app's
// architecture honest without a real parser — deliberately dumb regex/
// substring scans over the source tree, so this file stays auditable no
// matter how many changes land on top of it. Run via `npm run build` /
// `npm run check` (see package.json); exits 1 and prints every violation
// found (not just the first) if anything trips, exits 0 with a short
// summary otherwise.
//
// The four rules (see PLAN.md / CLAUDE.md for the "why"):
//   1. No non-empty inline <script> in app/public/**/*.html — pages are
//      shells, all behaviour lives in bundled modules.
//   2. No DOM access (document./location./bare window.) under
//      app/public/lib/** — those modules take config as arguments so a
//      later React rewrite can reuse them unedited.
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, '..');
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
function checkLibFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    if (DOM_ACCESS_RE.test(line)) {
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
// Run all four rules
// ---------------------------------------------------------------------------

const htmlFiles = walk(PUBLIC_DIR, (f) => f.toLowerCase().endsWith('.html'));
for (const file of htmlFiles) checkHtmlFile(file);

const libFiles = walk(LIB_DIR, (f) => f.endsWith('.js') || f.endsWith('.mjs'));
for (const file of libFiles) checkLibFile(file);

const serverFiles = walk(SERVER_DIR, () => true);
for (const file of serverFiles) checkServerFile(file);

const isSource = (f) => f.endsWith('.js') || f.endsWith('.mjs');
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
  console.log(`[check-structure] OK: scanned ${htmlFiles.length} HTML file(s), ${libFiles.length} lib file(s), ${serverFiles.length} server file(s), ${proseFiles.length} source file(s) for prose ratio, no violations${warned}`);
  process.exit(0);
}
