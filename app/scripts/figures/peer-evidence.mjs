// The retained-evidence readers peer-figures.mjs and peer-checks.mjs share, so
// the figures and the checks that verify them read one cohort and one window.

export const finite = (value) => Number.isFinite(value);
export const safe = (value) => Number.isSafeInteger(value) && value >= 0;
export const pathOf = (value) => String(value ?? '').split(/[?#]/, 1)[0];

export function tagsOf(input) {
  return input.declaredClientTags ?? input.clientTags ?? Object.keys(input.clients ?? {});
}

/** A peer condition that declares a response settle gap: its settled host read, unreceived examination and bypass check apply. */
export function declaresResponseSettle(condition) {
  return Object.prototype.hasOwnProperty.call(condition?.bars ?? {}, 'responseSettleGapMs');
}

export function recordsOf(client) {
  return Array.isArray(client?.peerRecords) ? client.peerRecords : [];
}

export function inWindow(value, window) {
  return finite(value) && finite(window?.startMs) && finite(window?.endMs)
    && value >= window.startMs && value < window.endMs;
}

export function originSnapshot(value) {
  return value?.counters ?? value ?? {};
}

export function responseRecords(value) {
  const records = originSnapshot(value).responseRecords;
  return Array.isArray(records) ? records : [];
}

/** The completion cohort: segments whose completion falls inside the window. */
export function cohortSegments(records, window) {
  return records.filter((record) => record?.kind === 'segment' && inWindow(record.completedAtMs, window));
}

/** Sum of a byte field over entries, a missing or unsafe value counting zero. */
export function sumBytes(entries, field) {
  return entries.reduce((sum, entry) => sum + (safe(entry[field]) ? entry[field] : 0), 0);
}
