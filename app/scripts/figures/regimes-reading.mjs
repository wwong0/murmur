// Pure classification for the registered 7c regime reading.

const finite = (value) => Number.isFinite(value);

function uploadTotal(value, tag, boundary) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`upload-rate-boundary-unavailable:${boundary}:${tag}`);
  }
  const values = Object.values(value);
  if (values.some((entry) => !finite(entry) || entry < 0)) {
    throw new Error(`upload-rate-boundary-invalid:${boundary}:${tag}`);
  }
  return values.reduce((total, entry) => total + entry, 0);
}

export function computeViewerUploadRates({ manifest = {}, boundaryStart = {}, boundaryEnd = {} } = {}) {
  const windowMs = Number(manifest.window?.endMs) - Number(manifest.window?.startMs);
  if (!finite(windowMs) || windowMs <= 0) throw new Error('upload-rate-window-invalid');
  const probePaths = manifest.topology?.probePaths;
  if (!probePaths || typeof probePaths !== 'object' || Array.isArray(probePaths)) {
    throw new Error('upload-rate-probe-paths-unavailable');
  }
  const declared = Object.keys(manifest.clients ?? {}).filter((tag) => /^c\d+$/.test(tag) && tag !== 'c00');
  const tags = declared.length ? declared : Object.keys(probePaths)
    .filter((tag) => /^c\d+$/.test(tag) && tag !== 'c00');
  const seconds = windowMs / 1000;
  return Object.fromEntries(tags.map((tag) => {
    const before = uploadTotal(boundaryStart.clients?.[tag]?.uploadBytes, tag, 'start');
    const after = uploadTotal(boundaryEnd.clients?.[tag]?.uploadBytes, tag, 'end');
    const uploadBytes = after - before;
    if (uploadBytes < 0) throw new Error(`upload-rate-delta-negative:${tag}`);
    return [tag, {
      uploadBytes,
      uploadRateBitsPerSecond: uploadBytes * 8 / seconds,
      peerLinkRateBitsPerSecond: probePaths[tag]?.peerLinkRateBitsPerSecond ?? null,
    }];
  }));
}

function valuesOf(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => !finite(entry))) {
    throw new Error('reading-median-values-invalid');
  }
  return [...value].sort((left, right) => left - right);
}

export function median(values) {
  const order = valuesOf(values);
  const middle = Math.floor(order.length / 2);
  return order.length % 2 ? order[middle] : (order[middle - 1] + order[middle]) / 2;
}

// The register's label and the runner's retained verdict must agree: the recompute
// cannot see the live refusals (7c d1-findings.md F3).
function accepted(entry) {
  return entry?.outcome === 'complete' && entry?.publishes === true
    && entry?.finalization?.writeByte === true;
}

function figureOf(entry) {
  return entry?.report?.figures ?? entry?.figures ?? {};
}

function conditionOf(entry) {
  return entry?.condition ?? entry?.manifest?.condition?.name ?? entry?.report?.manifest?.condition?.name ?? null;
}

// Viewers only: the host tab records no build id.
function buildIdsOf(entry) {
  const clients = entry?.manifest?.clients ?? entry?.clients ?? {};
  return Object.fromEntries(Object.entries(clients)
    .filter(([, client]) => client?.role !== 'host')
    .map(([tag, client]) => [tag, client?.buildId ?? null])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function imagesOf(entry) {
  return entry?.manifest?.topology?.regime?.images ?? null;
}

// The rig is the image pair the run's containers came from (7c d1-findings.md F4).
function sameBuild(left, right) {
  const leftIds = buildIdsOf(left);
  const rightIds = buildIdsOf(right);
  const tags = Object.keys(leftIds);
  const leftImages = imagesOf(left);
  return tags.length > 0 && JSON.stringify(leftIds) === JSON.stringify(rightIds)
    && Object.values(leftIds).every((value) => typeof value === 'string' && value.length > 0)
    && typeof leftImages?.origin === 'string' && typeof leftImages?.client === 'string'
    && JSON.stringify(leftImages) === JSON.stringify(imagesOf(right));
}

function published(entry, figures) {
  const byte = entry?.report?.publishedByte ?? entry?.publishedByte;
  return byte?.published !== false && finite(figures.peerFractionAggregate);
}

function runSummary(entry) {
  const figures = figureOf(entry);
  const multiplier = figures.hostUploadMultiplier;
  const steady = figures.steadyState;
  const eligible = accepted(entry)
    && conditionOf(entry) === 'regimes-limited-shaped'
    && published(entry, figures)
    && steady?.steady === true
    && finite(multiplier);
  const refusal = figures.hostUploadMultiplierRefusal ?? (steady?.steady === false ? {
    reason: steady.reason,
    failedLegs: steady.failedLegs ?? Object.entries(steady.legs ?? {})
      .filter(([, leg]) => leg?.pass !== true)
      .map(([leg, value]) => ({ leg, value })),
    legs: steady.legs ?? null,
  } : null);
  return {
    directory: entry?.directory ?? null,
    condition: conditionOf(entry),
    accepted: accepted(entry),
    eligible,
    peerFractionAggregate: finite(figures.peerFractionAggregate) ? figures.peerFractionAggregate : null,
    hostUploadMultiplier: finite(multiplier) ? multiplier : null,
    hostFetchOnceRatio: finite(figures.hostFetchOnceRatio) ? figures.hostFetchOnceRatio : null,
    refusal: eligible ? null : refusal,
    legs: steady?.legs ?? null,
    buildIds: buildIdsOf(entry),
    uploadRates: entry?.uploadRates ?? null,
    ...(entry?.recomputeError ? { outcome: entry.outcome, recomputeError: entry.recomputeError } : {}),
  };
}

function controlSummary(entries, reading, eligibleRuns) {
  const config = reading.control ?? {};
  const candidates = entries.filter((entry) => accepted(entry) && conditionOf(entry) === config.condition);
  for (const entry of candidates) {
    const figures = figureOf(entry);
    const peerFraction = figures.peerFractionAggregate;
    const sameBuildAsEligible = eligibleRuns.every((run) => sameBuild(entry, run));
    if (finite(peerFraction) && peerFraction >= config.peerFractionMin && sameBuildAsEligible) {
      return {
        directory: entry.directory ?? null,
        condition: conditionOf(entry),
        accepted: true,
        peerFractionAggregate: peerFraction,
        steady: figureOf(entry).steadyState?.steady === true,
        legs: figureOf(entry).steadyState?.legs ?? null,
        buildIds: buildIdsOf(entry),
        qualifies: true,
      };
    }
  }
  return candidates.map((entry) => {
    const figures = figureOf(entry);
    return {
      directory: entry.directory ?? null,
      condition: conditionOf(entry),
      accepted: true,
      peerFractionAggregate: finite(figures.peerFractionAggregate) ? figures.peerFractionAggregate : null,
      steady: figureOf(entry).steadyState?.steady === true,
      legs: figureOf(entry).steadyState?.legs ?? null,
      buildIds: buildIdsOf(entry),
      qualifies: false,
      sameBuildAsEligible: eligibleRuns.every((run) => sameBuild(entry, run)),
    };
  });
}

// The block committed in conditions.json before any measured run; nothing defaults.
function thresholds(value) {
  const numbers = [value?.reading1?.peerFractionMin, value?.reading1?.multiplierMax, value?.reading2?.peerFractionBelow,
    value?.reading2?.multiplierAbove, value?.marginPeerFraction, value?.marginMultiplier, value?.control?.peerFractionMin];
  if (value?.figure !== 'median' || !numbers.every(finite) || typeof value.control.condition !== 'string'
    || !Number.isInteger(value.eligibleRunsMin) || !Number.isInteger(value.eligibleRunsMax)
    || value.eligibleRunsMin < 1 || value.eligibleRunsMax < value.eligibleRunsMin) throw new Error('reading-thresholds-invalid');
  return value;
}

export function classifyRegimesReading({ runs = [], reading } = {}) {
  const config = thresholds(reading);
  const runsList = Array.isArray(runs) ? runs : [];
  const runsSummary = runsList.map(runSummary);
  const eligibleSummaries = runsSummary.filter((entry) => entry.eligible);
  if (eligibleSummaries.length > config.eligibleRunsMax) throw new Error('eligible-run-count-exceeds-max');
  const eligibleEntries = runsList.filter((entry) => runSummary(entry).eligible);
  const control = controlSummary(runsList, config, eligibleEntries);
  const hasControl = Array.isArray(control) ? false : control?.qualifies === true;
  const enough = eligibleSummaries.length >= config.eligibleRunsMin;
  const result = {
    diagnostic: false,
    criterion: true,
    reading: 'No reading',
    readingKey: 'none',
    thresholds: {
      reading1: config.reading1,
      reading2: config.reading2,
      marginPeerFraction: config.marginPeerFraction,
      marginMultiplier: config.marginMultiplier,
      eligibleRunsMin: config.eligibleRunsMin,
      eligibleRunsMax: config.eligibleRunsMax,
      control: config.control,
    },
    runs: runsSummary,
    eligibleRuns: eligibleSummaries,
    eligibleCount: eligibleSummaries.length,
    control,
    medians: null,
    reasons: [
      ...(enough ? [] : ['eligible-run-count']),
      ...(hasControl ? [] : ['control-unavailable']),
    ],
  };
  if (!enough || !hasControl) return result;
  const peerFractionAggregate = median(eligibleSummaries.map((entry) => entry.peerFractionAggregate));
  const hostUploadMultiplier = median(eligibleSummaries.map((entry) => entry.hostUploadMultiplier));
  result.medians = { peerFractionAggregate, hostUploadMultiplier };
  if (peerFractionAggregate >= config.reading1.peerFractionMin && hostUploadMultiplier <= config.reading1.multiplierMax) {
    result.reading = 'Reading 1';
    result.readingKey = 'reading-1';
  } else if (peerFractionAggregate < config.reading2.peerFractionBelow || hostUploadMultiplier > config.reading2.multiplierAbove) {
    result.reading = 'Reading 2';
    result.readingKey = 'reading-2';
  } else {
    result.reading = 'Reading 3';
    result.readingKey = 'reading-3';
  }
  result.reasons = [];
  return result;
}
