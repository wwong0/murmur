// Page steps that more than one driver performs. A step that does not hold throws and
// names itself, so a driver's row fails on the step rather than on what came after it.

import { clickElement, sleep } from './cdp.mjs';

const STEP_WAIT_MS = 2_000;
const PROMPT_WAIT_MS = 3_000;
const POLL_MS = 50;
const ENABLE_WAIT_MS = 10_000;
const CHOOSABLE_WAIT_MS = 30_000;
const CHOOSABLE_POLL_MS = 100;
const ENABLED_UNPRESSED = '#control-mode [data-mode][aria-pressed="false"]:not([disabled]):not([data-disabled])';

// `tolerant` reads a failed evaluate as "not there yet": a page that was only just told to
// navigate answers from a context that is going away.
async function waitForPresence(tab, selector, present, { waitMs = STEP_WAIT_MS, tolerant = false } = {}) {
  const expression = `document.querySelector(${JSON.stringify(selector)}) !== null`;
  const deadline = Date.now() + waitMs;
  const read = async () => {
    if (!tolerant) return tab.evaluate(expression);
    try { return await tab.evaluate(expression); } catch { return false; }
  };
  for (;;) {
    if (await read() === present) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

async function pressEscape(tab) {
  for (const type of ['keyDown', 'keyUp']) {
    await tab.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
}

/**
 * Closes the name prompt that a plain invite link opens over the room, so the page's next
 * coordinate click is not taken by its backdrop. Call it right after the
 * page is opened. It is idempotent: a page with no prompt answers `{ shown: false, closed: true }`
 * after the wait. The answer is for the driver's console, never a row.
 */
export async function closeNamePrompt(tab) {
  const shown = await waitForPresence(tab, '#name-prompt', true, { waitMs: PROMPT_WAIT_MS, tolerant: true });
  if (!shown) return { shown: false, closed: true };
  await pressEscape(tab);
  return { shown: true, closed: await waitForPresence(tab, '#name-prompt', false) };
}

// Waits until the host's file input takes a pick. A page that was only just told to navigate
// reads as "not yet", as in `closeNamePrompt`.
async function waitHostFileEnabled(tab) {
  const expression = `document.querySelector('#host-file')?.disabled === false`;
  const deadline = Date.now() + CHOOSABLE_WAIT_MS;
  for (;;) {
    let enabled = false;
    try { enabled = await tab.evaluate(expression); } catch { /* the page is going away: not yet */ }
    if (enabled === true) return true;
    if (Date.now() >= deadline) throw new Error('host file never became choosable');
    await sleep(CHOOSABLE_POLL_MS);
  }
}

/**
 * Sets `filename` on the host's file input over CDP, once the input takes a pick. The input
 * carries the disabled flag while the source is not choosable, and a pick set on it then is
 * dropped with nothing to say so, so every driver picks through this.
 */
export async function setHostFile(tab, filename) {
  await waitHostFileEnabled(tab);
  const { root } = await tab.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await tab.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#host-file' });
  if (!nodeId) throw new Error('host file input is missing');
  await tab.send('DOM.setFileInputFiles', { nodeId, files: [filename] });
}

/**
 * Changes the room's control mode through the settings menu, as a person does: open
 * `#settings`, press the item that is not pressed, close the menu. The menu floats over the
 * page, so a step that left it open would take the next coordinate click.
 * `click` is the caller's coordinate click: verify-browser has its own.
 */
export async function toggleControlMode(tab, { click = clickElement } = {}) {
  const step = async (name, run) => {
    try {
      await run();
    } catch (error) {
      throw new Error(`toggleControlMode: ${name} failed: ${error.message}`);
    }
  };
  const wait = (name, selector, present) => step(name, async () => {
    if (!await waitForPresence(tab, selector, present)) throw new Error(`${selector} was not ${present ? 'present' : 'absent'} within ${STEP_WAIT_MS} ms`);
  });
  await step('opening #settings', () => click(tab, '#settings'));
  await wait('waiting for #control-mode', '#control-mode', true);
  // post-result: the toggle stays disabled while an operation is in flight, and a
  // click on it then does nothing; the base waited for the control itself to be enabled.
  await step('waiting for the unpressed mode to be enabled', async () => {
    if (!await waitForPresence(tab, ENABLED_UNPRESSED, true, { waitMs: ENABLE_WAIT_MS })) throw new Error(`${ENABLED_UNPRESSED} was not present within ${ENABLE_WAIT_MS} ms`);
  });
  await step('pressing the unpressed mode', () => click(tab, '#control-mode [data-mode][aria-pressed="false"]'));
  await step('sending Escape', () => pressEscape(tab));
  await wait('waiting for #control-mode to close', '#control-mode', false);
  return true;
}
