import { defaultExec, dockerExec } from '../../harness/apply-qdisc.mjs';
import { CLIENT_ORIGIN_URL } from './topology.mjs';
import { createRequestRecorder } from './cdp-records.mjs';
import { segmentName } from '../../public/lib/remux-publish.mjs';

const finite = (value) => Number.isFinite(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const QUALIFICATION_MEDIA_POSITION_MS = 6_000_000;

export function segmentAtMediaPosition(mediaMs, segmentSeconds) {
  if (!finite(segmentSeconds) || segmentSeconds <= 0) throw new Error('segment-seconds-unavailable');
  if (!finite(mediaMs) || mediaMs < 0) throw new Error('qualification-media-position-invalid');
  return segmentName(Math.floor(mediaMs / (segmentSeconds * 1000)));
}

export const CDP_QUALIFICATION_REASON = 'cdp-byte-mapping-unqualified';
export const LINK_RECEIPT_QUALIFICATION_REASON = 'link-receipt-mapping-unqualified';

/**
 * The CDP byte mapping, against a file whose size the origin reports. Until
 * this passes, no figure derived from the CDP
 * request records may be published, and the gate fails closed. It lives here
 * rather than beside the impairment verifier because the run driver needs it
 * too, and the verifier already imports from the driver.
 */
export async function qualifyCdpBytes(tab, { originContainer, origin = CLIENT_ORIGIN_URL, segmentSeconds, mediaPositionMs = QUALIFICATION_MEDIA_POSITION_MS, exec = defaultExec } = {}) {
  const segment = segmentAtMediaPosition(mediaPositionMs, segmentSeconds);
  const statSizeBytes = Number(dockerExec(originContainer, ['stat', '-c', '%s', `/media/${segment}`], exec).trim());
  const recorder = createRequestRecorder(tab);
  try {
    await tab.send('Network.enable');
    await tab.send('Network.setCacheDisabled', { cacheDisabled: true });
    const pageClock = await tab.evaluate('({ wallMs: Date.now(), performanceNowMs: performance.now() })');
    recorder.setPageMapping(pageClock);
    const fetched = await tab.evaluate(`fetch('/media/${segment}', { cache: 'no-store' }).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
    await sleep(1000);
    const records = recorder.flush().filter((record) => String(record.url).endsWith(segment));
    if (records.length !== 1) throw new Error(`CDP qualification saw ${records.length} records for ${segment}, expected exactly 1`);
    const record = records[0];
    return {
      status: record.bodyBytesFromChunks === record.bodyBytesFromTotal && record.bodyBytesFromTotal === statSizeBytes ? 'passed' : 'failed',
      segment,
      statSizeBytes,
      fetchedBytes: fetched,
      bodyBytes: record.bodyBytes,
      bodyBytesFromChunks: record.bodyBytesFromChunks,
      bodyBytesFromTotal: record.bodyBytesFromTotal,
      source: record.source,
      origin,
      measuredAt: new Date().toISOString(),
    };
  } finally {
    recorder.dispose();
  }
}

export function validateCdpQualification(record) {
  const statSize = Number(record?.statSizeBytes ?? record?.stat?.size);
  const chunks = Number(record?.bodyBytesFromChunks);
  const total = Number(record?.bodyBytesFromTotal);
  const attempted = record !== null && record !== undefined;
  const valid = record?.status === 'passed'
    && finite(statSize)
    && finite(chunks)
    && finite(total)
    && chunks === total
    && total === statSize;
  return {
    valid,
    reason: valid ? null : CDP_QUALIFICATION_REASON,
    attempted,
    status: record?.status ?? null,
    qualificationReason: record?.reason ?? null,
    statSizeBytes: statSize,
    bodyBytesFromChunks: chunks,
    bodyBytesFromTotal: total,
  };
}

// The four byte counts agree, the viewer saw the response finish and the host
// did not record it aborted. Each caller coerces its own inputs first.
function linkReceiptsAgree({ statSizeBytes, fetchedBytes, receiptBodyBytes, hostDeliveredBytes, receipt, hostRecord }) {
  return [fetchedBytes, receiptBodyBytes, hostDeliveredBytes, statSizeBytes].every(finite)
    && fetchedBytes === receiptBodyBytes
    && receiptBodyBytes === hostDeliveredBytes
    && hostDeliveredBytes === statSizeBytes
    && receipt?.finished === true
    && hostRecord?.aborted === false;
}

async function waitForOpen(tab, { timeoutMs = 30_000, now = Date.now, pause = sleep } = {}) {
  const until = now() + timeoutMs;
  while (now() < until) {
    const snapshot = await tab.evaluate('__app.hostLink()');
    if (snapshot?.state === 'open') return snapshot;
    await pause(100);
  }
  throw new Error('host link did not open before qualification timeout');
}

export const QUALIFICATION_FETCH_TIMEOUT = 'qualification-fetch-timeout';
// 180 s since 2026-10-08, after the first qualification attempt timed out at 30 s:
// a far fetch waits behind every urgent and near request while the viewers fill.
export const LINK_QUALIFICATION_TIMEOUT_MS = 180_000;
const QUALIFICATION_SLOT = '__waLinkQualification';

// The page keeps the fetch's outcome, so nothing in the runner awaits the body.
function issueFetchExpression(segment) {
  return `(() => {
    const slot = globalThis.${QUALIFICATION_SLOT} = { done: false, bytes: null, error: null, completedWallMs: null };
    fetch('/media/${segment}', { cache: 'no-store' }).then((r) => r.arrayBuffer())
      .then((b) => { slot.bytes = b.byteLength; }, (e) => { slot.error = String(e?.message ?? e); })
      .finally(() => { slot.completedWallMs = Date.now(); slot.done = true; });
    return Date.now();
  })()`;
}

/**
 * Issues the qualification fetch as soon as the viewer's host link is open, and
 * returns without awaiting its body: at that point the host
 * has no estimate and no pace to starve it behind.
 */
export async function beginLinkQualification(viewerTab, { segmentSeconds, mediaPositionMs = QUALIFICATION_MEDIA_POSITION_MS, now = Date.now, pause = sleep } = {}) {
  const segment = segmentAtMediaPosition(mediaPositionMs, segmentSeconds);
  const beginAtMs = now();
  await waitForOpen(viewerTab, { now, pause });
  const beforeMs = now();
  const pageWallMs = Number(await viewerTab.evaluate(issueFetchExpression(segment)));
  const fetchIssuedAtMs = now();
  if (!finite(pageWallMs)) throw new Error('link qualification fetch was not issued');
  return { viewerTab, segment, beginAtMs, fetchIssuedAtMs, wallOffsetMs: pageWallMs - (beforeMs + fetchIssuedAtMs) / 2 };
}

/** The host poll nearest an instant, and whether the host had an estimate at it. */
export function hostEstimateNear(readings = [], atMs) {
  if (!finite(atMs) || readings.length === 0) return null;
  const nearest = readings.reduce((best, entry) => (Math.abs(entry.atMs - atMs) < Math.abs(best.atMs - atMs) ? entry : best));
  return { pollAtMs: nearest.atMs, bytesPerSecond: nearest.bytesPerSecond, hadEstimate: finite(nearest.bytesPerSecond) && nearest.bytesPerSecond > 0 };
}

/**
 * Collects the fetch `beginLinkQualification` issued. A body not complete
 * `timeoutMs` after it was issued is a runner fault and throws; the four-way
 * agreement is otherwise the one earlier runs qualified with.
 */
export async function finishLinkQualification(handle, hostTab, { originContainer, timeoutMs = LINK_QUALIFICATION_TIMEOUT_MS, now = Date.now, pause = sleep, exec = defaultExec } = {}) {
  const { viewerTab, segment } = handle;
  let slot = null;
  while (true) {
    slot = await viewerTab.evaluate(`globalThis.${QUALIFICATION_SLOT} ?? null`);
    if (slot?.done === true) break;
    const elapsedMs = now() - handle.fetchIssuedAtMs;
    if (elapsedMs >= timeoutMs) {
      throw Object.assign(new Error(`${QUALIFICATION_FETCH_TIMEOUT}: ${segment} not complete after ${elapsedMs} ms`),
        { code: QUALIFICATION_FETCH_TIMEOUT, elapsedMs });
    }
    await pause(100);
  }
  if (slot.error !== null) throw new Error(`link qualification fetch failed: ${slot.error}`);
  const fetchedBytes = Number(slot.bytes);
  const statSizeBytes = Number(dockerExec(originContainer, ['stat', '-c', '%s', `/media/${segment}`], exec).trim());
  const until = now() + 30_000;
  let receipt = null;
  let hostRecord = null;
  let viewerLink = null;
  let hostCounters = null;
  while (now() < until) {
    viewerLink = await viewerTab.evaluate('__app.hostLink()');
    const receipts = await viewerTab.evaluate('__app.hostReceipts()');
    hostCounters = await hostTab.evaluate('__app.hostCounters()');
    receipt = receipts?.records?.filter((entry) => entry.url === `/media/${segment}`).at(-1) ?? null;
    hostRecord = hostCounters?.counters?.responseRecords?.find((entry) => entry.originResponseId === receipt?.originResponseId) ?? null;
    if (receipt && hostRecord) break;
    await pause(100);
  }
  const receiptBodyBytes = Number(receipt?.bodyBytes);
  const hostDeliveredBytes = Number(hostRecord?.delivered);
  const passed = linkReceiptsAgree({ statSizeBytes, fetchedBytes, receiptBodyBytes, hostDeliveredBytes, receipt, hostRecord });
  return {
    status: passed ? 'passed' : 'failed',
    segment,
    statSizeBytes,
    fetchedBytes,
    receiptBodyBytes,
    hostDeliveredBytes,
    receipt,
    hostRecord,
    hostLink: viewerLink,
    source: 'host-link-receipt',
    instants: {
      beginAtMs: handle.beginAtMs,
      fetchIssuedAtMs: handle.fetchIssuedAtMs,
      fetchCompletedAtMs: finite(slot.completedWallMs) ? slot.completedWallMs - handle.wallOffsetMs : null,
      finishAtMs: now(),
    },
    measuredAt: new Date().toISOString(),
  };
}

export function validateLinkReceiptQualification(record) {
  const statSizeBytes = record?.statSizeBytes == null ? NaN : Number(record.statSizeBytes);
  const fetchedBytes = record?.fetchedBytes == null ? NaN : Number(record.fetchedBytes);
  const receiptBodyBytes = record?.receiptBodyBytes == null ? NaN : Number(record.receiptBodyBytes);
  const hostDeliveredBytes = record?.hostDeliveredBytes == null ? NaN : Number(record.hostDeliveredBytes);
  const attempted = record !== null && record !== undefined;
  const valid = record?.status === 'passed'
    && linkReceiptsAgree({ statSizeBytes, fetchedBytes, receiptBodyBytes, hostDeliveredBytes, receipt: record?.receipt, hostRecord: record?.hostRecord });
  return {
    valid,
    reason: valid ? null : LINK_RECEIPT_QUALIFICATION_REASON,
    attempted,
    status: record?.status ?? null,
    statSizeBytes,
    fetchedBytes,
    receiptBodyBytes,
    hostDeliveredBytes,
  };
}
