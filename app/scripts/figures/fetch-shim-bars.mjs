const defineBar = (key, caseKey, read, check, bad) => Object.freeze({ key, case: caseKey, read, check, bad });

export const FETCH_SHIM_BARS = Object.freeze([
  defineBar('a.status', 'a', 'status', (o) => o?.status === 200, () => 500),
  defineBar('a.content-length', 'a', 'headers.contentLength', (o, e) => o?.headers?.contentLength === String(e.length), (e) => String(e.length + 1)),
  defineBar('a.body-bytes', 'a', 'bodyBytes', (o, e) => o?.bodyBytes === e.length, (e) => e.length - 1),
  defineBar('a.hash', 'a', 'hashMatches', (o) => o?.hashMatches === true, () => false),
  defineBar('a.settlement', 'a', 'settlement.kind', (o) => o?.settlement?.kind === 'complete', () => 'failed'),
  defineBar('a.receipt-finished', 'a', 'receipt.finished', (o) => o?.receipt?.finished === true, () => false),
  defineBar('a.receipt-canceled', 'a', 'receipt.canceled', (o) => o?.receipt?.canceled === false, () => true),

  defineBar('b.status', 'b', 'status', (o) => o?.status === 206, () => 200),
  defineBar('b.content-length', 'b', 'headers.contentLength', (o, e) => o?.headers?.contentLength === String(e.openRange.length), (e) => String(e.openRange.length + 1)),
  defineBar('b.content-range-start', 'b', 'headers.contentRange.from', (o, e) => o?.headers?.contentRange?.from === e.openRange.start, (e) => e.openRange.start + 1),
  defineBar('b.content-range-end', 'b', 'headers.contentRange.to', (o, e) => o?.headers?.contentRange?.to === e.openRange.end, (e) => e.openRange.end - 1),
  defineBar('b.content-range-total', 'b', 'headers.contentRange.total', (o, e) => o?.headers?.contentRange?.total === e.length || o?.headers?.contentRange?.total === '*', (e) => e.length + 1),
  defineBar('b.body-bytes', 'b', 'bodyBytes', (o, e) => o?.bodyBytes === e.openRange.length, (e) => e.openRange.length - 1),
  defineBar('b.hash', 'b', 'hashMatches', (o) => o?.hashMatches === true, () => false),
  defineBar('b.settlement', 'b', 'settlement.kind', (o) => o?.settlement?.kind === 'complete', () => 'failed'),
  defineBar('b.receipt-finished', 'b', 'receipt.finished', (o) => o?.receipt?.finished === true, () => false),
  defineBar('b.receipt-canceled', 'b', 'receipt.canceled', (o) => o?.receipt?.canceled === false, () => true),

  defineBar('c.status', 'c', 'status', (o) => o?.status === 206, () => 200),
  defineBar('c.content-length', 'c', 'headers.contentLength', (o) => o?.headers?.contentLength === '100', () => '101'),
  defineBar('c.content-range-start', 'c', 'headers.contentRange.from', (o) => o?.headers?.contentRange?.from === 100, () => 101),
  defineBar('c.content-range-end', 'c', 'headers.contentRange.to', (o) => o?.headers?.contentRange?.to === 199, () => 198),
  defineBar('c.body-bytes', 'c', 'bodyBytes', (o) => o?.bodyBytes === 100, () => 99),
  defineBar('c.hash', 'c', 'hashMatches', (o) => o?.hashMatches === true, () => false),
  defineBar('c.settlement', 'c', 'settlement.kind', (o) => o?.settlement?.kind === 'complete', () => 'failed'),
  defineBar('c.receipt-finished', 'c', 'receipt.finished', (o) => o?.receipt?.finished === true, () => false),
  defineBar('c.receipt-canceled', 'c', 'receipt.canceled', (o) => o?.receipt?.canceled === false, () => true),

  defineBar('d.status', 'd', 'status', (o) => o?.status === 200, () => 500),
  defineBar('d.content-length', 'd', 'headers.contentLength', (o, e) => o?.headers?.contentLength === String(e.length), (e) => String(e.length + 1)),
  defineBar('d.chunk-count', 'd', 'chunkCount', (o) => Number(o?.chunkCount) > 1, () => 1),
  defineBar('d.body-bytes', 'd', 'bodyBytes', (o, e) => o?.bodyBytes === e.length, (e) => e.length - 1),
  defineBar('d.hash', 'd', 'hashMatches', (o) => o?.hashMatches === true, () => false),
  defineBar('d.settlement', 'd', 'settlement.kind', (o) => o?.settlement?.kind === 'complete', () => 'failed'),
  defineBar('d.receipt-finished', 'd', 'receipt.finished', (o) => o?.receipt?.finished === true, () => false),
  defineBar('d.receipt-canceled', 'd', 'receipt.canceled', (o) => o?.receipt?.canceled === false, () => true),

  defineBar('e.status', 'e', 'status', (o) => o?.status === 200, () => 500),
  defineBar('e.content-length', 'e', 'headers.contentLength', (o, e) => o?.headers?.contentLength === String(e.length), (e) => String(e.length + 1)),
  defineBar('e.read-rejected', 'e', 'settlement.kind', (o) => o?.settlement?.kind === 'abort-read-rejected', () => 'abort-read-resolved'),
  defineBar('e.read-error', 'e', 'settlement.errorName', (o) => o?.settlement?.errorName === 'AbortError', () => 'TypeError'),
  defineBar('e.partial-body', 'e', 'bodyBytes', (o, e) => Number(o?.bodyBytes) > 0 && Number(o.bodyBytes) < e.length, (e) => e.length),
  defineBar('e.receipt-canceled', 'e', 'receipt.canceled', (o) => o?.receipt?.canceled === true, () => false),
  defineBar('e.receipt-finished', 'e', 'receipt.finished', (o) => o?.receipt?.finished === false, () => true),
  defineBar('e.receipt-body-bytes', 'e', 'receipt.bodyBytes', (o, e) => Number(o?.receipt?.bodyBytes) < e.length, (e) => e.length),
  defineBar('e.pending-cleared', 'e', 'pendingCleared', (o) => o?.pendingCleared === true, () => false),

  defineBar('f.status', 'f', 'status', (o) => o?.status === 200, () => 500),
  defineBar('f.content-length', 'f', 'headers.contentLength', (o, e) => o?.headers?.contentLength === String(e.length), (e) => String(e.length + 1)),
  defineBar('f.cancel-settled', 'f', 'settlement.kind', (o) => o?.settlement?.kind === 'cancel-resolved', () => 'cancel-rejected'),
  defineBar('f.cancel-error', 'f', 'settlement.errorName', (o) => o?.settlement?.errorName === null, () => 'TypeError'),
  defineBar('f.partial-body', 'f', 'bodyBytes', (o, e) => Number(o?.bodyBytes) > 0 && Number(o.bodyBytes) < e.length, (e) => e.length),
  defineBar('f.receipt-canceled', 'f', 'receipt.canceled', (o) => o?.receipt?.canceled === true, () => false),
  defineBar('f.receipt-finished', 'f', 'receipt.finished', (o) => o?.receipt?.finished === false, () => true),
  defineBar('f.receipt-body-bytes', 'f', 'receipt.bodyBytes', (o, e) => Number(o?.receipt?.bodyBytes) < e.length, (e) => e.length),
  defineBar('f.pending-cleared', 'f', 'pendingCleared', (o) => o?.pendingCleared === true, () => false),

  defineBar('g.fetch-rejected', 'g', 'settlement.kind', (o) => o?.settlement?.kind === 'fetch-rejected', () => 'fetch-resolved'),
  defineBar('g.abort-error', 'g', 'settlement.errorName', (o) => o?.settlement?.errorName === 'AbortError', () => 'TypeError'),
  defineBar('g.no-receipt', 'g', 'receipt', (o) => o?.receipt === null, () => ({})),
  defineBar('g.pending-unchanged', 'g', 'requestsUnchanged', (o) => o?.requestsUnchanged === true, () => false),
]);

function valueAt(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function setAt(value, path, replacement) {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((current, key) => {
    if (!current[key] || typeof current[key] !== 'object') current[key] = {};
    return current[key];
  }, value);
  parent[last] = replacement;
}

function validateExpected(expected) {
  if (!expected || !Number.isInteger(expected.length) || expected.length <= 0) throw new TypeError('fetch shim expected length must be positive');
  if (!expected.openRange || !Number.isInteger(expected.openRange.length)) throw new TypeError('fetch shim open range is required');
}

export function evaluateFetchShim(observations, expected) {
  validateExpected(expected);
  const bars = FETCH_SHIM_BARS.map((definition) => {
    const observation = observations?.[definition.case] ?? null;
    let pass = false;
    try { pass = Boolean(definition.check(observation, expected)); } catch {}
    return {
      key: definition.key,
      case: definition.case,
      read: definition.read,
      pass,
      observed: valueAt(observation, definition.read),
    };
  });
  const byCase = Object.fromEntries([...new Set(FETCH_SHIM_BARS.map((definition) => definition.case))].map((caseKey) => {
    const caseBars = bars.filter((bar) => bar.case === caseKey);
    return [caseKey, { pass: caseBars.every((bar) => bar.pass), bars: caseBars }];
  }));
  return { pass: bars.every((bar) => bar.pass), bars, byCase };
}

export function mutateFetchObservation(observations, key, expected) {
  validateExpected(expected);
  const definition = FETCH_SHIM_BARS.find((bar) => bar.key === key);
  if (!definition) throw new Error(`unknown fetch shim bar ${key}`);
  const mutated = structuredClone(observations);
  setAt(mutated[definition.case], definition.read, definition.bad(expected));
  return mutated;
}

