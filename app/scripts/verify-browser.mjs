// scripts/verify-browser.mjs
//
// The manual verification pass, automated: two Chrome windows join one room,
// both play, presence tracks, and the identity rules are exercised in every
// form a browser can actually produce.
// A dev aid, not part of `npm run check` — it needs Chrome, a running server
// and about ninety seconds, where the protocol check needs none of those.
//
// It exists because CLAUDE.md records that every defect in the host-origin
// spike was found by attaching over CDP and reading the console, and because
// design.md D10 settles that the developer here does not look at the page. A
// verification that requires someone to watch two tabs is a verification that
// stops being run.
//
// Usage: npm start (in another shell), then `node scripts/verify-browser.mjs`.
//
// Two things this had to get right to be worth running:
//
//  - Each page gets its OWN Chrome window. A second tab in one window is a
//    background tab, and a background tab does not autoplay, so the first run
//    of this reported the host "not playing" when the host was fine.
//  - 7.3 is split three ways. Chrome's browser process closes the websocket
//    cleanly even when the renderer is killed outright, so closing or crashing
//    a tab is an ordinary departure and never reaches the reclaim path.
//
//    7.3a is a SECOND LIVE window carrying the same tab id. Under change 1 it
//    reclaimed the host role, because presenting the same `tabId` was the whole
//    requirement. Change 1b keys the reclaim on a secret the server issues in
//    one directed reply, so that window is now a stranger holding a published
//    label and is refused — which is the point of the change, and is why this
//    expectation reads the opposite way to the way it used to.
//
//    It is also SLOW on purpose (D13). The refusal carries the time the server
//    would need to free that name, ~15s at the 5000ms default, and the newcomer
//    retries across it rather than guessing. So 7.3a checks two phases — that
//    it is visibly retrying, and that it later gives up — and that costs the
//    run about twenty seconds. That is the price of the budget being correct at
//    every liveness setting instead of only at the one the check uses.
//
//    7.3b covers close-and-reopen, where a briefly hostless room is correct and
//    specified behaviour. 7.3c reloads the host tab, which is the one case the
//    design accepts as lossy: a reload throws the secret away, so the returning
//    page is a stranger and depends on its own retry to get back in.
//
//    The true reclaim path — same tab, same page, secret intact — is not
//    reachable from a browser at all on loopback, because there is no way to
//    make a live page's connection half-open. It is asserted in
//    scripts/protocol-check.mjs instead.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, FLAGS, attach as attachTo, cdpHttp as cdpHttpOn, sleep, killChrome } from './cdp.mjs';
import { DRIFT_LINE_RE } from '../public/lib/drift-readout.mjs';

const PORT = 9223;
const ORIGIN = 'http://127.0.0.1:8100';

const cdpHttp = (pathname) => cdpHttpOn(PORT, pathname);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'app-verify-'));
const BUNDLE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'room.bundle.js');

/**
 * The gap the run IMPOSES between the two windows (3b design.md D3). Without it
 * the assertion below cannot fail: open both at the same instant and a working
 * timeline and a DELETED timeline both put both windows near position zero, so
 * the observation is identical in the two worlds it has to separate. With it,
 * a working timeline makes the second window catch up and a broken one leaves
 * it ten seconds behind. It is the input to the experiment, not dead time.
 */
const WINDOW_GAP_MS = 10000;

/**
 * How far apart the two windows' drift figures may be. NOT "one segment
 * duration": four seconds would admit a state in which the start position
 * achieved nothing. Measured over two runs during change 3b task 4 — the two
 * windows landed 96ms and 112ms apart — so this sits just above that and two
 * orders below the 10s the imposed gap produces with the timeline removed.
 */
const POSITION_TOLERANCE_MS = 200;

/**
 * One window against the room, which is a LOOSER question than the one above:
 * every client lands a fixed distance behind, because time passes between
 * choosing the start position and displaying the first frame (design.md D1).
 * Measured at 119–241ms; this bounds that, and change 4 is what closes it.
 */
const DRIFT_TOLERANCE_MS = 400;

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

const URL_A = `${ORIGIN}/room.html?room=demo&role=host&tab=A`;
const URL_B = `${ORIGIN}/room.html?room=demo&role=viewer&tab=B`;
const URL_V = `${ORIGIN}/room.html?room=demo&role=viewer&tab=V`;

// The first window IS page A — no about:blank bootstrap window.
const chrome = spawn(
  CHROME,
  [...FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=700,500', '--window-position=0,0', URL_A],
  { stdio: 'ignore' }
);

/**
 * A page in its OWN Chrome window — a second tab in one window is a background
 * tab, and a background tab does not autoplay, which is what made the first run
 * of this report the host "not playing" when the host was fine.
 *
 * `alreadyOpen` is the first window, the one Chrome was launched with: nothing
 * to spawn, and nothing to exclude, because that target is the one being looked
 * for.
 */
async function attach(label, url, alreadyOpen = false) {
  if (alreadyOpen) return attachTo(PORT, url, { label });
  const before = new Set((await cdpHttp('/json/list')).map((t) => t.id));
  spawn(CHROME, [...FLAGS, '--new-window', `--user-data-dir=${profile}`, '--window-size=700,500', url], { stdio: 'ignore' });
  return attachTo(PORT, url, { label, exclude: before });
}

// `currentTime` appears here and NOWHERE ELSE IN THIS FILE, for two questions it
// can answer: is this element playing, and has it advanced. It is not a drift
// primitive and is not used as one (`CONSTRAINTS.md` → *Playback measurement*):
// every figure below about WHERE a window is — the two-window agreement of 3.5
// included — is read from the drift records, which come from
// `requestVideoFrameCallback`.
const PROBE = `({
  time: document.querySelector('video').currentTime,
  paused: document.querySelector('video').paused,
  members: [...document.querySelectorAll('#roster li')].map(li => li.textContent.trim()),
  status: (document.querySelector('#status-line')||{}).textContent,
  clockText: (document.querySelector('#clock-line')||{}).textContent,
  driftText: (document.querySelector('#drift-line')||{}).textContent,
  notices: [...document.querySelectorAll('#notices li')].map(li => li.textContent.trim()),
})`;

/**
 * The harness seam (3b design.md D2), as change 6 will read it: values, not text
 * scraped back out of a string formatted for a person. `latest` is the newest
 * drift record — one client against the room timeline, NOT criterion 1's
 * pairwise figure.
 */
const SEAM = `(() => {
  const app = window.__app;
  if (!app) return { present: false };
  const drift = app.drift(0);
  return {
    present: true,
    buildId: app.buildId,
    clock: app.clock(),
    playback: app.playback(),
    counters: drift.counters,
    held: drift.records.length,
    latest: drift.records[drift.records.length - 1] ?? null,
    // THE WHOLE ARRAY, not a figure derived from it. The sawtooth amplitude the
    // controller's simulated plant runs on is measured from these records and
    // never chosen (change 4a design.md D8), and change 4b's model check reads
    // Chrome's real scatter back beside the plant's. Deleting this line costs
    // the only route from a real player to that constant.
    records: drift.records,
    // THE PAGE'S OWN ROLLING WINDOW, not a second one derived here. This
    // re-derivation took the upper of the middle two where the log takes their
    // mean, so the figure the run reported was never quite the one the page did.
    summary: app.summary(),
  };
})()`;

/** The seam, once the bundle has run. A page probed before that reports nothing. */
async function seamOf(tab, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seam = await tab.evaluate(SEAM);
    if (seam.present || Date.now() > deadline) return seam;
    await sleep(250);
  }
}

/**
 * How far this window has played PAST WHERE IT OPENED. `currentTime` on its own
 * stopped meaning "it is playing" the moment change 3b made playback start at
 * the room's position: the second window opens WINDOW_GAP_MS in BY CONSTRUCTION,
 * so `time > 1` is true of it before it has shown a single frame. A window whose
 * start position is unreadable yields NaN, which fails every comparison below
 * rather than passing one.
 */
function advancedMs(seam, probe) {
  const startedAt = seam.playback?.startedAtMediaMs;
  return Number.isFinite(startedAt) ? probe.time * 1000 - startedAt : NaN;
}

const failures = [];
function expect(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(label);
}

try {
  await cdpHttp('/json/version');
  const windows = await cdpHttp('/json/list');
  console.log(`(chrome opened ${windows.filter((t) => t.type === 'page').length} page target(s))`);

  console.log('\n--- 7.1 / 7.2: two windows, one room ---');
  const a = await attach('A/host', URL_A, true);

  console.log('\n--- 3.1: which build is this run talking to? ---');
  // A 200 on /room.html proves something is answering, not what it is
  // (`CONSTRAINTS.md` → *Reachable is not fresh*). This detects a page running a
  // DIFFERENT build, not a page misreporting its own — do not read it as more
  // than that (3b design.md D3).
  const seamEarly = await seamOf(a);
  expect('3.1 the page publishes the harness seam', seamEarly.present === true, JSON.stringify(seamEarly).slice(0, 120));
  const served = await (await fetch(`${ORIGIN}/room.bundle.js`)).text();
  const onDisk = fs.readFileSync(BUNDLE_PATH, 'utf8');
  console.log(`  build id: ${seamEarly.buildId} · served ${sha(served)} · on disk ${sha(onDisk)}`);
  expect('3.1 the origin serves this tree’s bundle', sha(served) === sha(onDisk), `served ${sha(served)}, on disk ${sha(onDisk)}`);
  expect(
    '3.1 the page is running the bundle the origin is serving',
    typeof seamEarly.buildId === 'string' && served.includes(seamEarly.buildId),
    `page reports ${seamEarly.buildId}`
  );

  // THE IMPOSED GAP (3.4) — the input to the experiment, not dead time. Read
  // WINDOW_GAP_MS before shortening or removing it.
  console.log(`\n--- 3.4: opening the second window ${WINDOW_GAP_MS / 1000}s late, on purpose ---`);
  await sleep(WINDOW_GAP_MS);
  const b = await attach('B/view', URL_B);

  await sleep(20000);
  const pa = await a.evaluate(PROBE);
  const pb = await b.evaluate(PROBE);
  console.log('  A:', JSON.stringify(pa));
  console.log('  B:', JSON.stringify(pb));
  // ONE SEAM READING PER WINDOW, taken here and used by every assertion down to
  // 3.5: `startedAtMediaMs` and the drift window have to describe the same
  // instant as `pa`/`pb` for the two to be compared at all.
  const sa = await seamOf(a);
  const sb = await seamOf(b);
  const advA = advancedMs(sa, pa);
  const advB = advancedMs(sb, pb);
  expect('7.1 both windows have played on past where they opened', advA > 1000 && advB > 1000, `A +${(advA / 1000).toFixed(1)}s past its start, B +${(advB / 1000).toFixed(1)}s`);
  expect('7.1 both rosters show two members', pa.members.length === 2 && pb.members.length === 2, `A=${pa.members.length} B=${pb.members.length}`);
  expect('7.1 rosters agree', JSON.stringify(pa.members.slice().sort()) === JSON.stringify(pb.members.slice().sort()));

  console.log('\n--- 3.2 / 3.3: what the page SAYS, not merely that the element is there ---');
  // Change 2's refusal-status defect — a `version-mismatch` reported to the user
  // as a host collision — reached review because the probe read element contents
  // and asserted nothing about them.
  const CLOCK_RE = /^clock: [+-]\d+\.\d+ms ± \d+\.\d+ms \(\d+ samples\)$/;
  // The line's shape comes from the module that builds it, so this and the free
  // suite covering the same format cannot drift apart (public/lib/drift-readout.mjs).
  for (const [label, probe] of [['A', pa], ['B', pb]]) {
    console.log(`  ${label} clock line: ${JSON.stringify(probe.clockText)}`);
    console.log(`  ${label} drift line: ${JSON.stringify(probe.driftText)}`);
    expect(`3.2 ${label}'s clock line stops saying "no estimate"`, !/no estimate/i.test(probe.clockText ?? ''), probe.clockText);
    expect(`3.2 ${label}'s clock line reports an offset, an uncertainty and a sample count`, CLOCK_RE.test((probe.clockText ?? '').trim()), probe.clockText);
    const drift = DRIFT_LINE_RE.exec((probe.driftText ?? '').trim());
    expect(`3.3 ${label}'s drift line reports a finite drift over a nonzero frame count`, drift !== null && Number(drift[1]) > 0, probe.driftText);
    expect(`3.3 ${label}'s summary is labelled a rolling window, not "median drift"`, !/median drift/i.test(probe.driftText ?? ''), probe.driftText);
  }

  console.log('\n--- 3.5 / 3.6 / 3.7: the two windows are in the same room, at the same place ---');
  console.log('  A seam:', JSON.stringify({ playback: sa.playback, summary: sa.summary, counters: sa.counters }));
  console.log('  B seam:', JSON.stringify({ playback: sb.playback, summary: sb.summary, counters: sb.counters }));

  // 3.7 — playback status as a VALUE, so change 6 can refuse a non-playing
  // client rather than average it in (D2). THE NO-CLOCK CASE IS NOT ASSERTED
  // HERE: reaching that state from a browser would need a test-only switch in
  // the page. scripts/check/suites/playback-start.mjs owns it, where a fake
  // clock makes it trivial (D3).
  for (const [label, seam] of [['A', sa], ['B', sb]]) {
    expect(`3.7 ${label} reports through the seam that it started playback`, seam.playback?.playing === true, JSON.stringify(seam.playback));
    expect(`3.7 ${label} reports no missing input`, seam.playback?.missing === null, JSON.stringify(seam.playback?.missing));
    expect(`3.7 ${label} opened the media exactly once`, seam.playback?.opens === 1 && seam.playback?.reopens === 0, `opens=${seam.playback?.opens} reopens=${seam.playback?.reopens}`);
  }

  // 3.6 — a pairwise figure across clients holding different reference points is
  // meaningless, so this is asserted before the two are compared at all.
  expect('3.6 both windows hold the same timeline reference point', sa.latest?.epochMs === sb.latest?.epochMs && Number.isFinite(sa.latest?.epochMs), `A=${sa.latest?.epochMs} B=${sb.latest?.epochMs}`);
  expect(`3.6 A is within ${DRIFT_TOLERANCE_MS}ms of the room`, Math.abs(sa.summary?.medianDriftMs ?? Infinity) <= DRIFT_TOLERANCE_MS, `median ${sa.summary?.medianDriftMs?.toFixed(1)}ms over ${sa.summary?.framesHeld} frames`);
  expect(`3.6 B is within ${DRIFT_TOLERANCE_MS}ms of the room`, Math.abs(sb.summary?.medianDriftMs ?? Infinity) <= DRIFT_TOLERANCE_MS, `median ${sb.summary?.medianDriftMs?.toFixed(1)}ms over ${sb.summary?.framesHeld} frames`);

  // 3.5 — the two windows agree with EACH OTHER. Drift is media minus scheduled
  // against a shared epoch, which is what makes two readings taken at different
  // instants comparable at all.
  const spread = Math.abs((sa.summary?.medianDriftMs ?? NaN) - (sb.summary?.medianDriftMs ?? NaN));
  expect(
    `3.5 the late window caught up: the two agree to within ${POSITION_TOLERANCE_MS}ms, not the ${WINDOW_GAP_MS / 1000}s it opened late`,
    spread <= POSITION_TOLERANCE_MS,
    `${spread.toFixed(1)}ms apart`
  );

  await sleep(15000);
  const pa2 = await a.evaluate(PROBE);
  const pb2 = await b.evaluate(PROBE);
  const advA2 = advancedMs(await seamOf(a), pa2);
  const advB2 = advancedMs(await seamOf(b), pb2);
  expect('7.2 playback continues past the first few segments', advA2 > 12000 && advB2 > 12000, `A +${(advA2 / 1000).toFixed(1)}s past its start, B +${(advB2 / 1000).toFixed(1)}s`);
  expect('7.2 neither window stalled', pa2.time > pa.time + 5 && pb2.time > pb.time + 5, `A +${(pa2.time - pa.time).toFixed(1)}s, B +${(pb2.time - pb.time).toFixed(1)}s`);

  console.log('\n--- 7.1: closing one updates the other ---');
  await cdpHttp(`/json/close/${b.targetId}`);
  await sleep(3000);
  const pa3 = await a.evaluate(PROBE);
  expect("7.1 closing B shrinks A's roster", pa3.members.length === 1, JSON.stringify(pa3.members));

  console.log('\n--- 7.3a: a second live window carrying the same tab id ---');
  // CHANGED BY change 1b, and this is the change in one place. Under change 1
  // this window reclaimed the host role, because presenting the same `tabId`
  // was the entire requirement — which is exactly why any member holding the
  // roster could do the same. It now holds no reclaim secret, so it is not the
  // same tab as far as the server is concerned: it is refused `tab-taken`,
  // retries for about a second against a holder that is answering pings, and
  // then reports that the name is in use. The incumbent is untouched.
  const v = await attach('V/view', URL_V);
  await sleep(3000);
  const noticesBefore = (await v.evaluate(PROBE)).notices.length;

  const a2 = await attach('A2/host', URL_A);

  // TWO PHASES NOW, because of D13. Under D11 this window gave up in about a
  // second, on a boolean saying the holder looked alive. That boolean could not
  // be read in time at this server's 5000ms interval, so the budget now comes
  // from the refusal itself: the server reports ~15s (three sweep ticks) and
  // the newcomer retries across it before giving up at ~18s, one backoff step
  // past the deadline.
  //
  // Phase one asserts it is visibly retrying, not hung and not silently gone.
  // Read from the NOTICES, not the status line: the status cycles through
  // retrying → disconnected → reconnecting → connected on every attempt, so any
  // single sample of it is a coin toss. The notice log accumulates.
  await sleep(6000);
  const pRetry = await a2.evaluate(PROBE);
  const refusalNotices = pRetry.notices.filter((n) => /join refused/i.test(n));
  console.log('  A2 while retrying:', JSON.stringify(refusalNotices.slice(-3)));
  expect('7.3a the newcomer reports the refusal immediately', refusalNotices.length >= 1, JSON.stringify(refusalNotices[0]));
  expect('7.3a and says it is retrying, with how long for', /retrying for up to \d+s/i.test(refusalNotices[0] ?? ''), refusalNotices[0]);
  expect('7.3a it is still retrying several seconds in', refusalNotices.length >= 2, `${refusalNotices.length} refusal notices`);

  const pvMid = await v.evaluate(PROBE);
  const pa1Mid = await a.evaluate(PROBE);
  expect('7.3a the incumbent keeps the host role while contested', pa1Mid.members.some((m) => /host/.test(m) && /^A /.test(m)), JSON.stringify(pa1Mid.members));
  expect('7.3a the incumbent was not superseded', !/superseded/i.test(pa1Mid.status), pa1Mid.status);
  expect('7.3a the viewer sees exactly one host', pvMid.members.filter((m) => /host/.test(m)).length === 1, JSON.stringify(pvMid.members));
  expect('7.3a the incumbent kept playing while contested', !pa1Mid.paused, `t=${pa1Mid.time.toFixed(2)}s`);

  // Phase two: past the reported window, it gives up for good.
  await sleep(18000);
  const pv = await v.evaluate(PROBE);
  const pa4 = await a2.evaluate(PROBE);
  const pa1 = await a.evaluate(PROBE);
  const duringContest = pv.notices.slice(noticesBefore);
  console.log('  V saw during the contest:', JSON.stringify(duringContest));
  console.log('  A2 final status:', JSON.stringify(pa4.status));
  console.log('  A (incumbent) roster:', JSON.stringify(pa1.members));

  // NAMES THE CODE, not merely the word "refused". The bare /refused:/ this
  // read before went red the moment change 2 made the page say `refused
  // (tab-taken):`, and stayed red for two changes because nobody runs this file
  // mid-change (CONSTRAINTS.md → *A check outside `npm run check`*).
  const REFUSED_RE = /^refused \(tab-taken\): .*in use/i;
  expect('7.3a the newcomer eventually gives up, and says which name is in use', REFUSED_RE.test(pa4.status ?? ''), pa4.status);
  expect('7.3a the incumbent still holds the role', pa1.members.some((m) => /host/.test(m) && /^A /.test(m)), JSON.stringify(pa1.members));
  expect('7.3a the viewer still sees exactly one host', pv.members.filter((m) => /host/.test(m)).length === 1, JSON.stringify(pv.members));
  // A refused join is a directed error that consumes no `seq`, so the room
  // never observes the attempt at all — no join, no leave, no presence. That
  // holds for every one of the retries, not just the first.
  expect('7.3a the room observed no membership change at any point', !duringContest.some((n) => /presence/.test(n)), JSON.stringify(duringContest));
  const advV = advancedMs(await seamOf(v), pv);
  expect('7.3a the viewer kept playing throughout', advV > 5000 && !pv.paused, `+${(advV / 1000).toFixed(1)}s past its start`);

  // Give the refused tab several backoff intervals to misbehave.
  await sleep(4000);
  const pv2 = await v.evaluate(PROBE);
  const swaps = pv2.notices.slice(noticesBefore).filter((n) => /presence/.test(n)).length;
  expect('7.3a the refused tab stays down once it has given up', swaps === 0, `${swaps} presence events after the refusal`);
  const pa4b = await a2.evaluate(PROBE);
  expect('7.3a and does not resume retrying', REFUSED_RE.test(pa4b.status ?? ''), pa4b.status);
  await cdpHttp(`/json/close/${a2.targetId}`);

  console.log('\n--- 7.3b: closing the host tab and reopening it with the same tab id ---');
  const noticesB = pv2.notices.length;
  await cdpHttp(`/json/close/${a.targetId}`);
  await sleep(1500);
  const a3 = await attach('A3/host', URL_A);
  await sleep(4000);
  const pv3 = await v.evaluate(PROBE);
  const pa5 = await a3.evaluate(PROBE);
  console.log('  V saw:', JSON.stringify(pv3.notices.slice(noticesB)));
  // A cleanly closed tab sends a websocket close frame, so this is an ordinary
  // departure followed by an ordinary join, NOT the reclaim path — the room is
  // briefly hostless, which the spec explicitly permits.
  expect('7.3b the reopened host holds the role again', pa5.members.some((m) => /host/.test(m) && /^A /.test(m)), JSON.stringify(pa5.members));
  expect('7.3b the viewer ends with exactly one host', pv3.members.filter((m) => /host/.test(m)).length === 1, JSON.stringify(pv3.members));
  const advV3 = advancedMs(await seamOf(v), pv3);
  expect('7.3b the viewer kept playing throughout', advV3 > 10000 && !pv3.paused, `+${(advV3 / 1000).toFixed(1)}s past its start`);

  console.log('\n--- 7.3c: reloading the host tab (change 1b task 4.3) ---');
  // The case design.md D4 names as the accepted hole: a reload throws the
  // reclaim secret away, so the new page is a stranger holding the old page's
  // label. It is normally invisible — a reloading tab produces a clean close,
  // so the room has no host by the time the new page joins — but if the join
  // beats the close, the new page is refused and has to retry itself in.
  //
  // Automated rather than done by hand because a verification that requires
  // someone to watch a tab is a verification that stops being run, and because
  // "how often" is the part worth knowing.
  const RELOADS = 6;
  let refusedReloads = 0;
  let failedReloads = 0;
  for (let i = 1; i <= RELOADS; i++) {
    await a3.send('Page.reload', { ignoreCache: false });
    await sleep(4000);
    await a3.send('Runtime.enable');
    const probe = await a3.evaluate(PROBE);
    const contested = probe.notices.some((n) => /refused/i.test(n));
    const holdsRole = probe.members.some((m) => /host/.test(m) && /^A /.test(m));
    if (contested) refusedReloads++;
    if (!holdsRole) failedReloads++;
    console.log(`  reload ${i}: ${holdsRole ? 'rejoined as host' : 'DID NOT REJOIN'}${contested ? ' (was refused first, then retried in)' : ''} — ${JSON.stringify(probe.status)}`);
  }
  expect(`7.3c every reload ends holding the host role (${RELOADS} reloads)`, failedReloads === 0, `${failedReloads} reload(s) did not rejoin`);
  console.log(`  ${refusedReloads}/${RELOADS} reload(s) hit the D4 race and were refused before retrying in`);

  const pv4 = await v.evaluate(PROBE);
  expect('7.3c the viewer ends with exactly one host', pv4.members.filter((m) => /host/.test(m)).length === 1, JSON.stringify(pv4.members));
  expect('7.3c the viewer kept playing throughout', !pv4.paused, `t=${pv4.time.toFixed(2)}s`);

} catch (err) {
  console.log('ERROR:', err.message);
  failures.push(err.message);
} finally {
  console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join('; ')}`}`);
  killChrome(chrome, profile);
  await sleep(1500);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(failures.length === 0 ? 0 : 1);
}
