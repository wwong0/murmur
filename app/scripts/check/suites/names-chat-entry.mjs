// Names and chat through the real entry: the rename line, the stored name,
// the chat entries and the refusals, over scripted envelopes.

import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

const NAME_KEY = 'watchalong.name';
const HOST = { clientId: 'c1', tabId: 'th', role: 'host', joinedAt: 1 };
const ME = { clientId: 'c2', tabId: 'tv2', role: 'viewer', joinedAt: 2 };
const OTHER = { clientId: 'c3', tabId: 'tv3', role: 'viewer', joinedAt: 3 };

const json = (value) => JSON.stringify(value);
const lines = (page) => page.view().activity.map((entry) => entry.text);

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

function presence(event, member, roster, { seq = 3, from = 'server' } = {}) {
  return { type: 'presence', from, seq, ts: { recv: 10_005 }, payload: { event, member, roster } };
}

function chat(from, text, id = 'm-0', seq = 4) {
  return { type: 'chat', from, to: 'room', id, seq, ts: { recv: 10_006 }, payload: { text } };
}

function refusal(replyTo, code, from = 'server') {
  return { type: 'error', from, replyTo, seq: null, ts: { recv: 10_007 }, payload: { code, detail: 'fixed' } };
}

// This page is c2, a viewer, in a room with the host c1.
function viewerPage(code, { stored = {}, roster = [HOST, ME] } = {}) {
  const store = storage(stored);
  const page = runEntry(code, { role: 'viewer', search: '?room=r&tab=tv2', globals: { sessionStorage: store } });
  page.emit('joined', { clientId: 'c2', role: 'viewer', seq: 1, roster });
  return { page, store };
}

export default async function namesChatEntrySuite() {
  const product = await bundleProductEntry();

  await check('names-chat-entry: a name presence writes the rename line, no join line, no send and one notice', async () => {
    const { page } = viewerPage(product.code, { roster: [HOST, ME, OTHER] });
    const sentBefore = page.sent().length;
    const noticesBefore = page.notices().length;
    const named = { ...OTHER, name: 'Ada' };
    page.deliver(presence('name', named, [HOST, ME, named]));
    assertEqual(json(lines(page)), json(['Guest 2 is now Ada']), 'only the rename line');
    assert(lines(page).every((text) => !text.includes('joined')), 'no join line');
    assertEqual(page.sent().length, sentBefore, 'nothing was sent');
    const added = page.notices().slice(noticesBefore);
    assertEqual(added.length, 1, 'one new notice');
    assert(added[0].includes('presence: name — tv3'), 'the existing presence notice, naming the tab');
    assert(!added[0].includes('Ada'), 'and not the name');
    assertEqual(json(page.view().roster), json(['th · host · c1', 'tv2 · viewer · c2', 'tv3 · viewer · c3']), '#roster keeps its identifier strings');
    assertEqual(json(page.view().people.map((p) => p.label)), json(['Host', 'Guest 1', 'Ada']), 'the people follow the name');
  });

  await check('names-chat-entry: a rename to the same label writes nothing, and a relayed name presence writes nothing', async () => {
    const { page } = viewerPage(product.code);
    page.deliver(presence('name', ME, [HOST, ME]));
    assertEqual(lines(page).length, 0, 'an unchanged label');
    const named = { ...HOST, name: 'Eve' };
    page.deliver(presence('name', named, [named, ME], { from: 'c3' }));
    assertEqual(lines(page).length, 0, 'only the server’s presence counts');
  });

  await check('names-chat-entry: a relayed chat adds one activity entry and no notice', async () => {
    const { page } = viewerPage(product.code);
    const noticesBefore = page.notices().length;
    page.deliver(chat('c1', 'hello <b>x</b>'));
    assertEqual(page.view().activity.length, 1, 'one entry');
    const entry = page.view().activity[0];
    assertEqual(json([entry.kind, entry.label, entry.tone, entry.text, entry.warn]), json(['chat', 'Host', 'host', 'hello <b>x</b>', false]), 'sender, tone and text as characters');
    assertEqual(page.notices().length, noticesBefore, 'no notice');
  });

  await check('names-chat-entry: chat entries share the hundred-line cap with the activity lines', async () => {
    const { page } = viewerPage(product.code);
    for (let i = 0; i < 120; i += 1) page.deliver(chat('c1', `line ${i}`, `m-${i}`, 4 + i));
    const activity = page.view().activity;
    assertEqual(activity.length, 100, 'capped');
    assertEqual(activity.at(-1).text, 'line 119', 'the newest is last');
  });

  await check('names-chat-entry: a chat whose body is not one text string adds nothing', async () => {
    const { page } = viewerPage(product.code);
    for (const payload of [{ text: 'hi', extra: 1 }, { text: 5 }, {}, { text: 'a\nb' }, { text: 'x'.repeat(501) }]) {
      page.deliver({ ...chat('c1', 'x'), payload });
    }
    assertEqual(page.view().activity.length, 0, 'nothing shown');
  });

  await check('names-chat-entry: an own chat reports relayed by id, a refused one reports refused and shows no line', async () => {
    const { page } = viewerPage(product.code);
    const { actions } = page.screens();
    const first = actions.sendChat('  hello there ');
    assertEqual(first, 'm-1', 'an id came back');
    assertEqual(page.events.find((e) => e.kind === 'send-chat').detail, 'hello there', 'the trimmed text went out');
    page.deliver(chat('c3', 'not mine', first));
    assertEqual(page.view().chatOutcome.id, null, 'another member’s message with the same id is not mine');
    page.deliver(chat('c2', 'hello there', first));
    assertEqual(json(page.view().chatOutcome), json({ id: 'm-1', result: 'relayed' }), 'relayed');
    const second = actions.sendChat('again');
    page.deliver(refusal(second, 'bad-envelope'));
    assertEqual(json(page.view().chatOutcome), json({ id: second, result: 'refused' }), 'refused');
    assertEqual(lines(page).filter((text) => text.includes('too fast')).length, 0, 'a bad-envelope refusal shows no line');
    assertEqual(page.view().activity.filter((entry) => entry.warn).length, 0, 'and no warning');
  });

  await check('names-chat-entry: a rate-limited refusal of an own send adds the warning line, and a stranger’s id adds none', async () => {
    const { page } = viewerPage(product.code);
    const { actions } = page.screens();
    const chatId = actions.sendChat('flood');
    const nameId = actions.setName('Zed');
    page.deliver(refusal('m-99', 'rate-limited'));
    page.deliver(refusal(chatId, 'rate-limited', 'c3'));
    assertEqual(page.view().activity.length, 0, 'an unknown id, and a refusal not from the server');
    page.deliver(refusal(chatId, 'rate-limited'));
    page.deliver(refusal(nameId, 'rate-limited'));
    const warnings = page.view().activity.filter((entry) => entry.warn);
    assertEqual(warnings.length, 2, 'one warning for the chat and one for the name');
    assertEqual(warnings[0].text, "You're sending too fast — wait a moment", 'the words');
    assert(!/rate-limited|m-\d/.test(warnings[0].text), 'no code in the line');
    assertEqual(json(page.view().chatOutcome), json({ id: chatId, result: 'refused' }), 'the refused chat keeps its text');
  });

  await check('names-chat-entry: actions send only text the rule accepts, trimmed, and only once joined', async () => {
    const store = storage();
    const early = runEntry(product.code, { role: 'viewer', search: '?room=r&tab=tv2', globals: { sessionStorage: store } });
    assertEqual(early.screens().actions.sendChat('early'), null, 'a chat before the join');
    assertEqual(early.screens().actions.setName('Ada'), null, 'a name before the join');
    const { page } = viewerPage(product.code);
    const { actions } = page.screens();
    for (const text of ['', '   ', 'a\nb', 'x'.repeat(501), 'rtl\u202E', 7, undefined]) {
      assertEqual(actions.sendChat(text), null, `chat ${JSON.stringify(text)?.slice(0, 12)}`);
    }
    for (const text of ['', '   ', 'x'.repeat(33), 'a\tb', 'rtl\u202E', 7, undefined]) {
      assertEqual(actions.setName(text), null, `name ${JSON.stringify(text)?.slice(0, 12)}`);
    }
    assertEqual(page.events.filter((e) => e.kind === 'send-chat' || e.kind === 'set-name').length, 0, 'nothing reached the client');
    assert(actions.sendChat('x'.repeat(500)) !== null, '500 sent');
    assert(actions.setName(` ${'y'.repeat(32)} `) !== null, '32 sent after trimming');
    assertEqual(page.events.filter((e) => e.kind === 'set-name')[0].detail, 'y'.repeat(32), 'the trimmed name went out');
  });

  await check('names-chat-entry: the stored name seeds the client, an invalid one is dropped, a throwing store is none', async () => {
    const seeded = runEntry(product.code, { role: 'viewer', search: '?room=r&tab=tv2', globals: { sessionStorage: storage({ [NAME_KEY]: 'Ada' }) } });
    assertEqual(seeded.harness.clientConfig.name, 'Ada', 'the stored name');
    const bad = runEntry(product.code, { role: 'viewer', search: '?room=r&tab=tv2', globals: { sessionStorage: storage({ [NAME_KEY]: 'a\nb' }) } });
    assertEqual(bad.harness.clientConfig.name, undefined, 'an invalid stored name');
    const empty = runEntry(product.code, { role: 'viewer', search: '?room=r&tab=tv2', globals: { sessionStorage: storage() } });
    assertEqual(empty.harness.clientConfig.name, undefined, 'no stored name');
    const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    const none = runEntry(product.code, { role: 'viewer', search: '?room=r&tab=tv2', globals: { sessionStorage: throwing } });
    assertEqual(none.harness.clientConfig.name, undefined, 'a throwing store');
    none.emit('joined', { clientId: 'c2', role: 'viewer', seq: 1, roster: [HOST, { ...ME, name: 'Ada' }] });
    assertEqual(json(none.view().people.map((p) => p.label)), json(['Host', 'Ada']), 'and the page still works');
  });

  await check('names-chat-entry: storage holds the roster’s accepted name, never the input and never a refused one', async () => {
    const { page, store } = viewerPage(product.code, { roster: [HOST, { ...ME, name: 'Ada' }] });
    assertEqual(store.data.get(NAME_KEY), 'Ada', 'written from the joined roster');
    assertEqual(page.view().ownName, 'Ada', 'the view knows the own name');
    assertEqual(page.view().selfClientId, 'c2', 'and the own entry');
    const { actions } = page.screens();
    const id = actions.setName('Zed');
    assertEqual(store.data.get(NAME_KEY), 'Ada', 'the input alone writes nothing');
    page.deliver(refusal(id, 'rate-limited'));
    assertEqual(store.data.get(NAME_KEY), 'Ada', 'a refused rename leaves the accepted name');
    const bo = { ...ME, name: 'Bo' };
    page.deliver(presence('name', bo, [HOST, bo]));
    assertEqual(store.data.get(NAME_KEY), 'Bo', 'the accepted rename');
    page.deliver(presence('name', { ...HOST, name: 'Eve' }, [{ ...HOST, name: 'Eve' }, bo], { from: 'c3' }));
    page.deliver(presence('name', ME, [HOST, { ...ME }], { seq: 5, from: 'c3' }));
    assertEqual(store.data.get(NAME_KEY), 'Bo', 'a relayed presence writes nothing');
    page.deliver(presence('name', ME, [HOST, ME], { seq: 6 }));
    assertEqual(store.data.has(NAME_KEY), false, 'unnamed in the roster removes the key');
  });

  await check('names-chat-entry: the own entry reopens the prompt by a request count', async () => {
    const { page } = viewerPage(product.code);
    assertEqual(page.view().namePromptRequest, 0, 'none yet');
    page.screens().actions.openNamePrompt();
    page.screens().actions.openNamePrompt();
    assertEqual(page.view().namePromptRequest, 2, 'each request counts');
  });

  // Guarded: widening the `event === 'join'` guard in notePresence to accept `name`
  // turns the first check's "no join line" assertions red.
}
