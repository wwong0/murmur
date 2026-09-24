// The one page reading both peer-exchange runners evaluate (verify-peer-exchange
// and verify-browser's 5.1).
//
// Taken inside the MutationObserver callback that follows the page's next paint
// of #bytes-line, so the painted line and peerBytes() describe the same instant:
// a plain read compares the last paint with bytes that arrived since, and B4's
// equality fails on a healthy page. `synced: false` means no paint arrived within
// the wait and the two were read apart; B4 then fails rather than guessing.

export const PEER_PAGE_READING = `new Promise((resolve) => {
  const app = window.__app;
  if (!app) { resolve({ present: false }); return; }
  const normalize = (value) => value === undefined ? { __type: 'undefined' }
    : typeof value === 'function' ? { __type: 'function' }
    : Array.isArray(value) ? value.map(normalize)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
    : value;
  const line = document.getElementById('bytes-line');
  const video = document.querySelector('video');
  const read = (synced) => ({
    present: true,
    synced,
    buildId: app.buildId,
    peerExchange: app.peerExchange(),
    peerBytes: app.peerBytes(),
    bytesLine: line ? line.textContent : null,
    peerEngineConfig: normalize(app.peerEngineConfig()),
    hostLink: app.hostLink(),
    hostReceipts: app.hostReceipts(),
    playback: app.playback(),
    currentTime: video ? video.currentTime : null,
  });
  if (!line) { resolve(read(false)); return; }
  let timer = null;
  const observer = new MutationObserver(() => {
    observer.disconnect();
    clearTimeout(timer);
    resolve(read(true));
  });
  observer.observe(line, { childList: true, characterData: true, subtree: true });
  timer = setTimeout(() => { observer.disconnect(); resolve(read(false)); }, 2000);
})`;
