import fs from 'node:fs';

export const USAGE_KEYS = Object.freeze(['since', 'roomsOpened', 'visits', 'largestRoom', 'watchedMs']);

export function readUsageFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new TypeError(`APP_USAGE_FILE cannot be read: ${error.message}`);
  }
  let value;
  try { value = JSON.parse(text); }
  catch { throw new TypeError('APP_USAGE_FILE is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== USAGE_KEYS.length || !USAGE_KEYS.every((key) => Object.hasOwn(value, key))) {
    throw new TypeError('APP_USAGE_FILE must contain exactly the usage keys');
  }
  const date = typeof value.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.since)
    ? new Date(`${value.since}T00:00:00Z`) : new Date(NaN);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.since) {
    throw new TypeError('APP_USAGE_FILE since must be a real date');
  }
  for (const key of USAGE_KEYS.slice(1)) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new TypeError(`APP_USAGE_FILE ${key} must be a non-negative safe integer`);
  }
  return value;
}

export function writeUsageFile(file, totals) {
  const ordered = Object.fromEntries(USAGE_KEYS.map((key) => [key, totals[key]]));
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(ordered)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

export function usageLine({ since, roomsOpened, visits, largestRoom, watchedMs }) {
  return `${roomsOpened} rooms, ${visits} visits, ${(watchedMs / 3_600_000).toFixed(1)} hours watched since ${since} (largest room ${largestRoom})`;
}

export function createUsageCount({ file, now, log, flushMs, keepMs }) {
  const totals = readUsageFile(file) ?? { since: new Date(now()).toISOString().slice(0, 10), roomsOpened: 0, visits: 0, largestRoom: 0, watchedMs: 0 };
  let written = JSON.stringify(totals);
  if (!fs.existsSync(file)) writeUsageFile(file, totals);
  const live = new Set();
  // A reaped room's counted tabs, by name, in memory for keepMs: a sole member's reload is not a new room or visit (D4).
  const kept = new Map();
  function write() {
    const current = JSON.stringify(totals);
    if (current === written) return;
    try { writeUsageFile(file, totals); written = current; }
    catch (error) { log(`usage write failed: ${error.message}`); }
  }
  function flush() {
    for (const tracker of live) tracker.accrue();
    write();
  }
  const timer = setInterval(flush, flushMs);
  timer.unref();
  function room(name) {
    const prior = kept.get(name);
    if (prior) { clearTimeout(prior.timer); kept.delete(name); }
    const admittedTabs = prior?.admittedTabs ?? new Set();
    let members = 0;
    let playing = false;
    let lastAt = now();
    let opened = prior !== undefined;
    const tracker = {
      accrue() {
        const t = now();
        if (playing && members > 0 && t > lastAt) totals.watchedMs += Math.round((t - lastAt) * members);
        lastAt = t;
      },
      admit({ tabId, reclaim, size }) {
        tracker.accrue();
        if (!opened) { opened = true; totals.roomsOpened += 1; }
        if (!reclaim && !admittedTabs.has(tabId)) { admittedTabs.add(tabId); totals.visits += 1; }
        totals.largestRoom = Math.max(totals.largestRoom, size);
        members = size;
        write();
      },
      depart(size) { tracker.accrue(); members = size; },
      setPlaying(flag) { tracker.accrue(); playing = flag === true; },
      end() {
        tracker.accrue(); members = 0; live.delete(tracker);
        if (!opened) return;
        const timer = setTimeout(() => kept.delete(name), keepMs);
        timer.unref();
        kept.set(name, { admittedTabs, timer });
      },
    };
    live.add(tracker);
    return tracker;
  }
  return { totals: () => ({ ...totals }), room, flush, close() { clearInterval(timer); for (const entry of kept.values()) clearTimeout(entry.timer); kept.clear(); flush(); } };
}
