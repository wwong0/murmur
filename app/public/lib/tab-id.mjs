export function parseStoredTab(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value.room === 'string' && typeof value.tab === 'string'
      ? { room: value.room, tab: value.tab } : null;
  } catch { return null; }
}

export function chooseTabId({ urlTab, stored, room, navigationType, draw }) {
  if (typeof urlTab === 'string' && urlTab.length > 0) return { tabId: urlTab, store: null };
  // `stored` is parseStoredTab's result: null or two strings.
  const tab = navigationType === 'reload' && stored?.room === room && stored.tab ? stored.tab : draw();
  return { tabId: tab, store: { room, tab } };
}
