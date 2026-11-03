import { check, assertEqual } from '../harness.mjs';
import { chooseTabId, parseStoredTab } from '../../../public/lib/tab-id.mjs';

export default async function tabIdSuite() {
  let draws = 0;
  const draw = () => `draw-${++draws}`;
  const base = { room: 'room', stored: { room: 'room', tab: 'stored' }, draw };
  await check('T1 reload reuses the matching tab', async () => {
    assertEqual(JSON.stringify(chooseTabId({ ...base, navigationType: 'reload' })), JSON.stringify({ tabId: 'stored', store: { room: 'room', tab: 'stored' } }), 'reused');
    assertEqual(draws, 0, 'no draw');
  });
  await check('T2 other navigation draws', async () => {
    for (const navigationType of ['navigate', 'back_forward', null]) {
      const result = chooseTabId({ ...base, navigationType });
      assertEqual(result.tabId, `draw-${draws}`, 'drawn');
      assertEqual(result.store.tab, result.tabId, 'stored');
    }
    assertEqual(draws, 3, 'three draws');
  });
  await check('T3 another room draws', async () => {
    assertEqual(chooseTabId({ ...base, room: 'other', navigationType: 'reload' }).tabId, 'draw-4', 'fresh');
  });
  await check('T4 URL tab wins', async () => {
    assertEqual(JSON.stringify(chooseTabId({ ...base, urlTab: 'url', navigationType: 'reload' })), JSON.stringify({ tabId: 'url', store: null }), 'URL');
    assertEqual(draws, 4, 'no draw');
  });
  await check('T5 malformed storage', async () => {
    for (const text of ['{', '{"room":1,"tab":"x"}', 'null']) assertEqual(parseStoredTab(text), null, 'invalid');
  });
}
