import { defaultExec, dockerExec } from '../../harness/apply-qdisc.mjs';
import { CLIENT_ORIGIN_URL } from './topology.mjs';
import { createRequestRecorder } from './cdp-records.mjs';

const finite = (value) => Number.isFinite(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const CDP_QUALIFICATION_REASON = 'cdp-byte-mapping-unqualified';
export const LINK_RECEIPT_QUALIFICATION_REASON = 'link-receipt-mapping-unqualified';

/**
 * The CDP byte mapping, against a file whose size the origin reports
 * (executor-spec.md §5.4). Until this passes, no figure derived from the CDP
 * request records may be published, and the gate fails closed. It lives here
 * rather than beside the impairment verifier because the run driver needs it
 * too, and the verifier already imports from the driver.
 */
export async function qualifyCdpBytes(tab, { originContainer, origin = CLIENT_ORIGIN_URL, segment = 'seg-01500.m4s', exec = defaultExec } = {}) {
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

async function waitForOpen(tab, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const snapshot = await tab.evaluate('__app.hostLink()');
    if (snapshot?.state === 'open') return snapshot;
    await sleep(100);
  }
  throw new Error('host link did not open before qualification timeout');
}

export async function qualifyLinkReceipts(viewerTab, hostTab, { originContainer, segment = 'seg-01500.m4s', exec = defaultExec } = {}) {
  const statSizeBytes = Number(dockerExec(originContainer, ['stat', '-c', '%s', `/media/${segment}`], exec).trim());
  await waitForOpen(viewerTab);
  const fetchedBytes = await viewerTab.evaluate(`fetch('/media/${segment}', { cache: 'no-store' }).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
  const until = Date.now() + 30_000;
  let receipt = null;
  let hostRecord = null;
  let viewerLink = null;
  let hostCounters = null;
  while (Date.now() < until) {
    viewerLink = await viewerTab.evaluate('__app.hostLink()');
    const receipts = await viewerTab.evaluate('__app.hostReceipts()');
    hostCounters = await hostTab.evaluate('__app.hostCounters()');
    receipt = receipts?.records?.filter((entry) => entry.url === `/media/${segment}`).at(-1) ?? null;
    hostRecord = hostCounters?.counters?.responseRecords?.find((entry) => entry.originResponseId === receipt?.originResponseId) ?? null;
    if (receipt && hostRecord) break;
    await sleep(100);
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
