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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9223;
const ORIGIN = 'http://127.0.0.1:8100';
const FLAGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
  '--no-first-run',
  '--no-default-browser-check',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'app-verify-'));

const URL_A = `${ORIGIN}/room.html?room=demo&role=host&tab=A`;
const URL_B = `${ORIGIN}/room.html?room=demo&role=viewer&tab=B`;
const URL_V = `${ORIGIN}/room.html?room=demo&role=viewer&tab=V`;

// The first window IS page A — no about:blank bootstrap window.
const chrome = spawn(
  CHROME,
  [...FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=700,500', '--window-position=0,0', URL_A],
  { stdio: 'ignore' }
);

async function cdpHttp(pathname) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
      const text = await res.text();
      try {
        return JSON.parse(text); // /json/close answers in plain text
      } catch {
        return { text };
      }
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`CDP not reachable at ${pathname}`);
}

class Tab {
  constructor(label, target) {
    this.label = label;
    this.id = 0;
    this.pending = new Map();
    this.targetId = target.id;
    this.ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    this.ready = new Promise((resolve) => this.ws.once('open', resolve));
    this.ws.on('error', () => {});
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => (a.value !== undefined ? a.value : (a.description ?? a.type))).join(' ');
        console.log(`  [${this.label}] ${text}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        console.log(`  [${this.label}] EXCEPTION ${msg.params.exceptionDetails.text}`);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, { resolve }));
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${this.label}: ${r.exceptionDetails.text}`);
    return r.result.value;
  }
}

async function attach(label, url, alreadyOpen = false) {
  const before = alreadyOpen ? new Set() : new Set((await cdpHttp('/json/list')).map((t) => t.id));
  if (!alreadyOpen) {
    spawn(CHROME, [...FLAGS, '--new-window', `--user-data-dir=${profile}`, '--window-size=700,500', url], { stdio: 'ignore' });
  }
  for (let i = 0; i < 80; i++) {
    const list = await cdpHttp('/json/list');
    const found = list.find((t) => t.type === 'page' && !before.has(t.id) && t.url.startsWith(url.split('?')[0]));
    if (found && found.webSocketDebuggerUrl) {
      const tab = new Tab(label, found);
      await tab.ready;
      await tab.send('Runtime.enable');
      return tab;
    }
    await sleep(250);
  }
  throw new Error(`window for ${label} never appeared`);
}

const PROBE = `({
  time: document.querySelector('video').currentTime,
  paused: document.querySelector('video').paused,
  members: [...document.querySelectorAll('#roster li')].map(li => li.textContent.trim()),
  status: (document.querySelector('#status-line')||{}).textContent,
  notices: [...document.querySelectorAll('#notices li')].map(li => li.textContent.trim()),
})`;

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
  const b = await attach('B/view', URL_B);

  await sleep(20000);
  const pa = await a.evaluate(PROBE);
  const pb = await b.evaluate(PROBE);
  console.log('  A:', JSON.stringify(pa));
  console.log('  B:', JSON.stringify(pb));
  expect('7.1 both windows are playing', pa.time > 1 && pb.time > 1, `A t=${pa.time.toFixed(2)}s B t=${pb.time.toFixed(2)}s`);
  expect('7.1 both rosters show two members', pa.members.length === 2 && pb.members.length === 2, `A=${pa.members.length} B=${pb.members.length}`);
  expect('7.1 rosters agree', JSON.stringify(pa.members.slice().sort()) === JSON.stringify(pb.members.slice().sort()));

  await sleep(15000);
  const pa2 = await a.evaluate(PROBE);
  const pb2 = await b.evaluate(PROBE);
  expect('7.2 playback continues past the first few segments', pa2.time > 12 && pb2.time > 12, `A t=${pa2.time.toFixed(2)}s B t=${pb2.time.toFixed(2)}s`);
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

  expect('7.3a the newcomer eventually gives up, and says the name is in use', /refused:/i.test(pa4.status) && /in use/i.test(pa4.status), pa4.status);
  expect('7.3a the incumbent still holds the role', pa1.members.some((m) => /host/.test(m) && /^A /.test(m)), JSON.stringify(pa1.members));
  expect('7.3a the viewer still sees exactly one host', pv.members.filter((m) => /host/.test(m)).length === 1, JSON.stringify(pv.members));
  // A refused join is a directed error that consumes no `seq`, so the room
  // never observes the attempt at all — no join, no leave, no presence. That
  // holds for every one of the retries, not just the first.
  expect('7.3a the room observed no membership change at any point', !duringContest.some((n) => /presence/.test(n)), JSON.stringify(duringContest));
  expect('7.3a the viewer kept playing throughout', pv.time > 5 && !pv.paused, `t=${pv.time.toFixed(2)}s`);

  // Give the refused tab several backoff intervals to misbehave.
  await sleep(4000);
  const pv2 = await v.evaluate(PROBE);
  const swaps = pv2.notices.slice(noticesBefore).filter((n) => /presence/.test(n)).length;
  expect('7.3a the refused tab stays down once it has given up', swaps === 0, `${swaps} presence events after the refusal`);
  const pa4b = await a2.evaluate(PROBE);
  expect('7.3a and does not resume retrying', /refused:/i.test(pa4b.status), pa4b.status);
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
  expect('7.3b the viewer kept playing throughout', pv3.time > 10 && !pv3.paused, `t=${pv3.time.toFixed(2)}s`);

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
  chrome.kill();
  spawn('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore' });
  await sleep(1500);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(failures.length === 0 ? 0 : 1);
}
