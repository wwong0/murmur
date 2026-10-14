// D4's length decision reads one registered arm shape. Missing accepted runs
// are null; this reader does not infer them from aliases or nested run records.

const finite = (value) => Number.isFinite(value);
const nameOf = (seconds) => `${seconds}s`;

function waitsOf(arm, field) {
  return Array.isArray(arm?.[field]) ? arm[field].filter(finite) : [];
}

function fiveResult(seconds, five, baseline) {
  const criteria = five ? {
    criterion2: five.criterion2 === true,
    criterion3: five.criterion3 === true,
    startRecovery: five.startRecovery === true,
  } : null;
  const startWaits = waitsOf(five, 'startWaits');
  const seekWaits = waitsOf(five, 'seekWaits');
  if (!five) return { seconds, replaces: null, reason: 'accepted-five-run-unavailable', criteria, startWaits, seekWaits };
  if (five.accepted !== true || Object.values(criteria).some((value) => value !== true)) {
    return { seconds, replaces: false, reason: 'five-criteria-not-met', criteria, startWaits, seekWaits };
  }
  if (!baseline || baseline.accepted !== true || !baseline.startWaits.length || !baseline.seekWaits.length
    || !startWaits.length || !seekWaits.length) {
    return { seconds, replaces: null, reason: 'accepted-waits-unavailable', criteria, startWaits, seekWaits };
  }
  const below = (values, reference) => values.every((value) => reference.every((other) => value < other));
  const replaces = below(startWaits, baseline.startWaits) && below(seekWaits, baseline.seekWaits);
  return { seconds, replaces, reason: replaces ? 'all-waits-below-4s' : 'wait-overlap', criteria, startWaits, seekWaits };
}

function tenResult(ten) {
  if (!ten || ten.accepted !== true) return ten ? false : null;
  return ten.criterion2 === true;
}

function testAt(result, seconds, arm, output) {
  output.tested.push(seconds);
  if (result.replaces !== true) return false;
  const ten = tenResult(arm?.ten);
  if (ten === null) {
    output.nextAction = `run-ten-${nameOf(seconds)}`;
    return true;
  }
  if (ten) {
    output.chosen = seconds;
    return true;
  }
  output.dropped.push(seconds);
  return false;
}

/** Apply D4's fixed 1s -> 2s -> 4s order and strict all-pairs waits. */
export function lengthRule({ arms = {} } = {}) {
  const baseline = arms['4s']?.five ? {
    accepted: arms['4s'].five.accepted === true,
    startWaits: waitsOf(arms['4s'], 'startWaits'),
    seekWaits: waitsOf(arms['4s'], 'seekWaits'),
  } : null;
  const candidates = Object.fromEntries([1, 2].map((seconds) => [nameOf(seconds),
    fiveResult(seconds, arms[nameOf(seconds)]?.five ?? null, baseline)]));
  const result = { candidates, baseline: { seconds: 4, accepted: baseline?.accepted === true,
    startWaits: baseline?.startWaits ?? [], seekWaits: baseline?.seekWaits ?? [] },
    tested: [], chosen: null, dropped: [], nextAction: null };

  if (testAt(candidates['1s'], 1, arms['1s'], result)) return result;
  if (result.nextAction) return result;
  if (testAt(candidates['2s'], 2, arms['2s'], result)) return result;
  if (result.nextAction) return result;

  result.tested.push(4);
  result.chosen = 4;
  if (tenResult(arms['4s']?.ten) === null) result.nextAction = 'run-ten-4s';
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function servedBuildIds(manifest) {
  const ids = Object.values(manifest?.clients ?? {}).map((client) => client?.buildId)
    .filter((value) => typeof value === 'string' && value.length > 0);
  if (typeof manifest?.servedBuildId === 'string') ids.push(manifest.servedBuildId);
  if (typeof manifest?.buildId === 'string') ids.push(manifest.buildId);
  return [...new Set(ids)].sort();
}

function identityOf(entry) {
  const manifest = entry?.manifest ?? {};
  return { directory: entry?.directory ?? null, outcome: entry?.outcome ?? null,
    buildIds: servedBuildIds(manifest), images: manifest?.regime?.images ?? null };
}

/** Refuse active accepted register entries with mixed served builds or images. */
export function buildCheck({ runs = [], register = null } = {}) {
  const entries = (register?.runs ?? runs).filter((entry) => entry?.outcome === 'accepted');
  const active = entries.filter((entry) => typeof entry.invalidatedBy !== 'string' || !entry.invalidatedBy);
  const pairs = active.map(identityOf);
  const keys = [...new Set(pairs.map((pair) => JSON.stringify(canonical({ buildIds: pair.buildIds, images: pair.images }))))];
  return keys.length <= 1 ? { accepted: true, reason: null, pairs } : { accepted: false, reason: 'mixed-build', pairs, keys };
}
