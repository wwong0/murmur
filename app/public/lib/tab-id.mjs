export function parseStoredTab(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value.room === 'string' && typeof value.tab === 'string'
      ? { room: value.room, tab: value.tab } : null;
  } catch { return null; }
}

export function chooseTabId({ urlTab, stored, room, navigationType, draw }) {
  if (typeof urlTab === 'string' && urlTab.length > 0) return { tabId: urlTab, store: null };
  const tab = navigationType === 'reload' && stored && typeof stored === 'object'
    && stored.room === room && typeof stored.tab === 'string' && stored.tab.length > 0
    ? stored.tab : draw();
  return { tabId: tab, store: { room, tab } };
}
