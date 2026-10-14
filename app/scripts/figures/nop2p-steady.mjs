// One-viewing arithmetic for host-delivered runs.

import { normalizeMediaPath } from './receipt-cohort.mjs';
import { computeOneViewing } from './one-viewing.mjs';
import { steadyState } from './peer-figures.mjs';

const finite = (value) => Number.isFinite(value);

function inWindow(value, window) {
  return finite(value) && value >= window.startMs && value <= window.endMs;
}

function receiptList(client) {
  return client?.receipts ?? client?.requests ?? client?.requestRecords ?? [];
}

export function receiptSegments(client, window) {
  if (!Array.isArray(receiptList(client))) throw new Error('link receipts are unavailable');
  return receiptList(client).filter((receipt) => {
    const path = normalizeMediaPath(receipt?.url);
    return path?.endsWith('.m4s') && receipt.finished === true && receipt.canceled !== true
      && inWindow(receipt.endMs, window);
  }).map((receipt) => {
    const lengthBytes = Number(receipt.bodyBytes ?? receipt.lengthBytes ?? receipt.bytes);
    if (!finite(lengthBytes) || lengthBytes < 0) throw new Error('link receipt length is invalid');
    return { path: normalizeMediaPath(receipt.url), lengthBytes, completedAtMs: receipt.endMs };
  });
}

export function computeNoP2pSteady({ input = {}, figures = {}, tags = [], offsets = {} } = {}) {
  const oneViewing = computeOneViewing({
    clients: input.clients,
    tags,
    window: input.window,
    offsets,
    segmentSizes: input.content?.segmentSizes ?? input.segmentSizes,
    segmentSeconds: input.segmentSeconds,
  });
  const cohorts = Object.fromEntries(tags.map((tag) => [tag, receiptSegments(input.clients?.[tag], input.window)]));
  const steady = steadyState({ input, tags, figures, cohorts, oneViewing });
  return { ...oneViewing, steadyState: steady };
}
