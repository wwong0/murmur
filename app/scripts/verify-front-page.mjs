// Browser proof for the front page and the room's header (change 12e, design.md D1–D3, D12,
// D13): the first screen at two sizes, the font served from this origin, the name, the header
// link, and the Stats panel leaving the layout's widths alone. It owns one default-paused
// server. Records carry booleans, counts and pixel boxes; nothing typed, no name.

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clickElement } from './cdp.mjs';
import { createPageDriver, present, read, SHORT_MS, until } from './runner/page-driver.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const driver = createPageDriver({ appDir: APP_DIR, runStem: '12e-front-page', port: 8137 });
const { origin: ORIGIN } = driver;
const ROOM = `fp-${crypto.randomBytes(6).toString('hex')}`;
const ROOM_URL = (role, tab) => `${ORIGIN}/room.html?room=${ROOM}&role=${role}&tab=${tab}`;
const HEADLINE = 'Watch together';
const FIRST_SCREEN = ['#front h1', '#host', '#join-input', '#join'];
const HEADER_LINK = '.room-header a[href]';
const WRITEUP_URL = 'https://github.com/wwong0/murmur/blob/main/WRITEUP.md';
const REPO_URL = 'https://github.com/wwong0/murmur';
// A number followed by a unit of time, rate or size, or a percent sign.
const FIGURE = String.raw`\d(?:[\d.,]*\d)?\s*(?:ms|s|Mbit\/s|MB|GB|%)(?![A-Za-z])`;
const ROSTER_COUNT = "document.querySelectorAll('#roster li').length";
const WIDTH_PX = 0.5;
const VIEWPORTS = {
  wide: { width: 1536, height: 864, deviceScaleFactor: 1, mobile: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};

const boxes = (selectors) => `(() => Object.fromEntries(${JSON.stringify(selectors)}.map((selector) => {
  const element = document.querySelector(selector);
  if (!element) return [selector, null];
  const r = element.getBoundingClientRect();
  return [selector, { left: r.left, top: r.top, right: r.right, bottom: r.bottom }];
})))()`;

const inside = (box, { width, height }) => box !== null && box.left >= 0 && box.top >= 0 && box.right <= width && box.bottom <= height;

async function rowFreshness() {
  return driver.withTab(ROOM_URL('host', 'fp0'), 'FP0', async (tab) => {
    const { bundle } = await driver.freshness(tab);
    const chromeRecorded = typeof driver.state.chromeVersion === 'string';
    return { exercised: true, ok: bundle.matches === true && bundle.pageIdInServed === true && chromeRecorded, detail: { bundleMatches: bundle.matches === true, pageIdInServed: bundle.pageIdInServed === true, chromeRecorded } };
  });
}

function rowFirstScreen(viewport) {
  return () => driver.withTab(`${ORIGIN}/`, `FP/${viewport.width}`, async (tab) => {
    await tab.send('Emulation.setDeviceMetricsOverride', viewport);
    const front = await until(tab, present('#host'), Boolean);
    if (!front.ok) return { exercised: false, detail: 'the front page did not render' };
    await driver.freshness(tab);
    const laidOut = await until(tab, `window.innerWidth === ${viewport.width}`, Boolean, SHORT_MS);
    await read(tab, 'window.scrollTo(0, 0)');
    const headline = await read(tab, "document.querySelector('#front h1')?.textContent.replace(/\\s+/g, ' ').trim() ?? null");
    const found = (await read(tab, boxes(FIRST_SCREEN))) ?? {};
    const within = Object.fromEntries(FIRST_SCREEN.map((selector) => [selector, inside(found[selector] ?? null, viewport)]));
    return {
      exercised: laidOut.ok,
      ok: headline === HEADLINE && Object.values(within).every(Boolean),
      detail: { headlineMatches: headline === HEADLINE, within, bottoms: Object.fromEntries(FIRST_SCREEN.map((selector) => [selector, found[selector]?.bottom ?? null])) },
    };
  });
}

// Every font the page asks for comes from this origin, and the face it names is loaded; a page
// still on the system stack has no font request at all, which reads FAIL.
async function rowFont() {
  const requests = new Map();
  const finished = new Map();
  const offOrigin = [];
  const record = (tab) => {
    tab.on('Network.requestWillBeSent', ({ requestId, request, type }) => {
      if (!request.url.startsWith(`${ORIGIN}/`) && !request.url.startsWith('data:')) offOrigin.push(type ?? 'unknown');
      if (type === 'Font') requests.set(requestId, request.url.startsWith(`${ORIGIN}/`));
    });
    tab.on('Network.responseReceived', ({ requestId, response }) => { if (requests.has(requestId)) finished.set(requestId, response.status); });
    return tab.send('Network.enable');
  };
  return driver.withTab(`${ORIGIN}/`, 'FP3', async (tab) => {
    const front = await until(tab, present('#host'), Boolean);
    if (!front.ok) return { exercised: false, detail: 'the front page did not render' };
    const loaded = await until(tab, `document.fonts.ready.then(() => [...document.fonts].filter((face) => face.family.replace(/"/g, '') === 'Instrument Sans' && face.status === 'loaded').length)`, (count) => count > 0, SHORT_MS);
    const statuses = [...finished.values()];
    const sameOrigin = [...requests.values()];
    return {
      exercised: true,
      ok: sameOrigin.length > 0 && sameOrigin.every(Boolean) && statuses.length === sameOrigin.length && statuses.every((status) => status === 200) && loaded.ok && offOrigin.length === 0,
      detail: { fontRequests: sameOrigin.length, sameOrigin: sameOrigin.filter(Boolean).length, ok200: statuses.filter((status) => status === 200).length, loadedFaces: loaded.value ?? 0, offOriginRequests: offOrigin.length },
    };
  }, { beforeNavigate: record });
}

// The front page holds two links: the write-up, and the repository as a named icon.
async function rowLinks() {
  return driver.withTab(`${ORIGIN}/`, 'FP7', async (tab) => {
    const front = await until(tab, present('#host'), Boolean);
    if (!front.ok) return { exercised: false, detail: 'the front page did not render' };
    const links = await read(tab, "[...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, named: (a.getAttribute('aria-label') ?? '').trim().length > 0 }))");
    const writeup = links?.filter((link) => link.href === WRITEUP_URL).length === 1;
    const repo = links?.find((link) => link.href === REPO_URL);
    return { exercised: true, ok: links?.length === 2 && writeup && repo?.named === true, detail: { links: links?.length ?? null, writeup, repo: Boolean(repo), repoNamed: repo?.named === true } };
  });
}

// The front page's rendered text states no figure.
async function rowNoFigure() {
  return driver.withTab(`${ORIGIN}/`, 'FP8', async (tab) => {
    const front = await until(tab, present('#host'), Boolean);
    if (!front.ok) return { exercised: false, detail: 'the front page did not render' };
    const figures = await read(tab, `(document.body.innerText.match(new RegExp(${JSON.stringify(FIGURE)}, 'g')) ?? []).length`);
    const length = await read(tab, 'document.body.innerText.length');
    return { exercised: length > 0, ok: figures === 0, detail: { figures, textLength: length } };
  });
}

async function rowName() {
  const front = await driver.withTab(`${ORIGIN}/`, 'FP4/front', async (tab) => {
    const shown = await until(tab, present('#host'), Boolean);
    return { shown: shown.ok, title: await read(tab, 'document.title') };
  });
  const room = await driver.withTab(ROOM_URL('host', 'fp4'), 'FP4/room', async (tab) => {
    const shown = await until(tab, present('#message-input'), Boolean);
    const header = await read(tab, `(() => {
      const link = document.querySelector(${JSON.stringify(HEADER_LINK)});
      return { title: document.title, text: link?.textContent.trim() ?? null, href: link?.href ?? null };
    })()`);
    return { shown: shown.ok, ...header };
  });
  const roomHeader = room.text === 'Murmur' && room.href === `${ORIGIN}/`;
  return {
    exercised: front.shown && room.shown,
    ok: front.title === 'Murmur' && room.title === 'Murmur' && roomHeader,
    detail: { frontTitle: front.title === 'Murmur', roomTitle: room.title === 'Murmur', headerLink: room.href !== null, headerText: room.text === 'Murmur', headerHref: room.href === `${ORIGIN}/` },
  };
}

async function rowViewerLeaves() {
  const host = await driver.openTab(ROOM_URL('host', 'fp5-h'), 'FP5/host');
  try {
    if (!(await until(host, present('#message-input'), Boolean)).ok) return { exercised: false, detail: 'the host did not render the room' };
    return await driver.withTab(ROOM_URL('viewer', 'fp5-v'), 'FP5/viewer', async (viewer) => {
      const two = await until(host, ROSTER_COUNT, (count) => count === 2);
      if (!two.ok) return { exercised: false, detail: { membersBefore: two.value } };
      const hasLink = await read(viewer, present(HEADER_LINK));
      if (hasLink !== true) return { exercised: true, ok: false, detail: { membersBefore: 2, headerLink: false } };
      await clickElement(viewer, HEADER_LINK);
      const left = await until(viewer, `location.pathname === '/' && ${present('#host')}`, Boolean);
      const one = await until(host, ROSTER_COUNT, (count) => count === 1);
      return { exercised: true, ok: left.ok && one.ok, detail: { membersBefore: 2, headerLink: true, frontPage: left.ok, membersAfter: one.value } };
    });
  } finally {
    await driver.closeTab(host);
  }
}

const LAYOUT = `(() => {
  const width = (selector) => document.querySelector(selector)?.getBoundingClientRect().width ?? null;
  return { player: width('#player'), column: width('.room-column'), gutter: window.innerWidth - document.documentElement.clientWidth, overflows: document.documentElement.scrollHeight > window.innerHeight };
})()`;

async function rowStatsKeepsWidths() {
  return driver.withTab(ROOM_URL('host', 'fp6'), 'FP6', async (tab) => {
    await tab.send('Emulation.setDeviceMetricsOverride', VIEWPORTS.wide);
    if (!(await until(tab, present('#message-input'), Boolean)).ok) return { exercised: false, detail: 'the host did not render the room' };
    const laidOut = await until(tab, `window.innerWidth === ${VIEWPORTS.wide.width}`, Boolean, SHORT_MS);
    if (await read(tab, "document.querySelector('#stats-panel')?.hidden") !== true) return { exercised: false, detail: 'Stats was open before the row' };
    const before = await read(tab, LAYOUT);
    await clickElement(tab, '#stats');
    const opened = await until(tab, "document.querySelector('#stats-panel')?.hidden === false", Boolean, SHORT_MS);
    const after = await read(tab, LAYOUT);
    const kept = (key) => before?.[key] != null && after?.[key] != null && Math.abs(before[key] - after[key]) <= WIDTH_PX;
    return { exercised: laidOut.ok && opened.ok && before !== null, ok: kept('player') && kept('column'), detail: { before, after } };
  });
}

await driver.run(async () => {
  await driver.runRow('FP0 the served bundle is the build, in a recorded Chrome', rowFreshness);
  await driver.runRow('FP1 at 1536x864 the headline, Host and the invite field with Join are on the first screen', rowFirstScreen(VIEWPORTS.wide));
  await driver.runRow('FP2 at 390x844 the headline, Host and the invite field with Join are on the first screen', rowFirstScreen(VIEWPORTS.phone));
  await driver.runRow('FP3 every font request is same-origin and the font loads', rowFont);
  await driver.runRow('FP4 the title reads Murmur on the front page and in a room, and the header shows it', rowName);
  await driver.runRow('FP5 a viewer following the header link reaches the front page and leaves the room', rowViewerLeaves);
  await driver.runRow("FP6 opening Stats keeps the player's and the right column's widths", rowStatsKeepsWidths);
  await driver.runRow('FP7 the front page holds exactly two links, the write-up and the named repository icon', rowLinks);
  await driver.runRow('FP8 the front page states no figure', rowNoFigure);
});
