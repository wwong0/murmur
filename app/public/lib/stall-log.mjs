export function createStallLog({ capacity = 100 } = {}) {
  let open = null;
  let count = 0;
  let totalMs = 0;
  let evicted = 0;
  const records = [];
  return {
    waiting(atMs) { if (open === null) open = { atMs }; },
    resumed(atMs) {
      if (open === null) return;
      const durationMs = Math.max(0, atMs - open.atMs);
      count += 1;
      totalMs += durationMs;
      records.push({ atMs: open.atMs, durationMs });
      if (records.length > capacity) { records.shift(); evicted += 1; }
      open = null;
    },
    read() { return { count, totalMs, open: open === null ? null : { atMs: open.atMs }, records: records.map((record) => ({ atMs: record.atMs, durationMs: record.durationMs })), evicted }; },
  };
}
