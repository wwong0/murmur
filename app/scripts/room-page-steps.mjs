// Page steps that more than one driver performs. A step that does not hold throws and
// names itself, so a driver's row fails on the step rather than on what came after it.

import { clickElement, sleep } from './cdp.mjs';

const STEP_WAIT_MS = 2_000;
const PROMPT_WAIT_MS = 3_000;
const POLL_MS = 50;

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
 * coordinate click is not taken by its backdrop (design.md D18, D19). Call it right after the
 * page is opened. It is idempotent: a page with no prompt answers `{ shown: false, closed: true }`
 * after the wait. The answer is for the driver's console, never a row.
 */
export async function closeNamePrompt(tab) {
  const shown = await waitForPresence(tab, '#name-prompt', true, { waitMs: PROMPT_WAIT_MS, tolerant: true });
  if (!shown) return { shown: false, closed: true };
  await pressEscape(tab);
  return { shown: true, closed: await waitForPresence(tab, '#name-prompt', false) };
}

/**
 * Changes the room's control mode through the settings menu, as a person does: open
 * `#settings`, press the item that is not pressed, close the menu. The menu floats over the
 * page, so a step that left it open would take the next coordinate click (design.md D11, D18).
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
  await step('pressing the unpressed mode', () => click(tab, '#control-mode [data-mode][aria-pressed="false"]'));
  await step('sending Escape', () => pressEscape(tab));
  await wait('waiting for #control-mode to close', '#control-mode', false);
  return true;
}
