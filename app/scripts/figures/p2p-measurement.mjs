const GATE_REASONS = Object.freeze([
  'control-refused',
  'control-below-floor',
  'control-missing',
  'build-mismatch',
  'images-mismatch',
  'naive-run-count',
  'naive-refused',
]);

const HEADLINE_FIELDS = Object.freeze(['peerFractionAggregate', 'hostUploadMultiplier']);
// Reported beside the reading; not part of it.
const MEDIAN_FIELDS = Object.freeze([...HEADLINE_FIELDS, 'hostWasteFraction']);
const finite = (value) => Number.isFinite(value);

function entryOf(value) {
  return { report: value?.report ?? value, manifest: value?.manifest ?? {} };
}

function figuresOf(entry) {
  return entry.report?.figures ?? entry.report?.publishedByte ?? {};
}

function ownRefusal(report) {
  if (report?.refusal && typeof report.refusal === 'object') {
    return report.refusal.refused === true || report.refusal.runRefused === true;
  }
  if (report?.finalization && typeof report.finalization === 'object') {
    return ['refused', 'aborted'].includes(report.finalization.status)
      || ['refused', 'failed'].includes(report.finalization.outcome);
  }
  return undefined;
}

function refused(entry) {
  const { report, manifest } = entry;
  const evaluated = ownRefusal(report);
  if (evaluated !== undefined) return evaluated;
  const status = manifest?.status;
  const outcome = manifest?.outcome;
  return ['refused', 'aborted'].includes(status)
    || ['refused', 'failed'].includes(outcome)
    || manifest?.refused === true
    || manifest?.runRefused === true
    || (Array.isArray(manifest?.refusalReasons) && manifest.refusalReasons.length > 0);
}

function bytePublished(entry) {
  const figure = entry.report?.publishedByte;
  return figure && figure.published !== false;
}

function accepted(entry) {
  return !refused(entry) && bytePublished(entry);
}

function imagePair(entry) {
  const images = entry.manifest?.regime?.images;
  return [images?.origin ?? null, images?.client ?? null];
}

function viewerTags(manifest) {
  if (Array.isArray(manifest?.declaredClientTags)) return manifest.declaredClientTags;
  if (Array.isArray(manifest?.clientTags)) return manifest.clientTags;
  const clients = manifest?.clients ?? {};
  const tags = Object.keys(clients).filter((tag) => clients[tag]?.role !== 'host' && tag !== 'c00');
  return tags;
}

function buildIds(entry) {
  return viewerTags(entry.manifest).map((tag) => entry.manifest?.clients?.[tag]?.buildId ?? null);
}

function samePair(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nearestRank(values) {
  if (!values.every(finite)) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length / 2) - 1];
}

function medianFigures(figures) {
  return Object.fromEntries(MEDIAN_FIELDS.map((field) => [field,
    nearestRank(figures.map((value) => value[field]))]));
}

function gateReasons(control, naive) {
  const reasons = [];
  if (!control || control.manifest?.condition?.name !== 'p2p-scattered') reasons.push('control-missing');
  if (!control) return reasons;
  if (!accepted(control)) reasons.push('control-refused');
  const controlAggregate = figuresOf(control).peerFractionAggregate;
  const floor = control.manifest?.condition?.bars?.controlFloorMin;
  if (!finite(controlAggregate) || !finite(floor) || controlAggregate < floor) reasons.push('control-below-floor');
  if (naive.length !== 3) reasons.push('naive-run-count');
  if (naive.some((entry) => entry.manifest?.condition?.name !== 'p2p-naive' || !accepted(entry))) {
    reasons.push('naive-refused');
  }
  const allRuns = [control, ...naive];
  const images = allRuns.map(imagePair);
  if (images.some((pair) => pair.some((value) => value === null)) || !images.every((pair) => samePair(pair, images[0]))) {
    reasons.push('images-mismatch');
  }
  const builds = allRuns.flatMap(buildIds);
  if (!builds.length || builds.some((value) => value === null) || new Set(builds).size !== 1) reasons.push('build-mismatch');
  return [...new Set(reasons)];
}

export function naiveMeasurement({ control, naive = [] } = {}) {
  const controlEntry = control ? entryOf(control) : null;
  const naiveEntries = Array.isArray(naive) ? naive.map(entryOf) : [];
  const reasons = gateReasons(controlEntry, naiveEntries);
  if (reasons.length) return { published: false, reasons };

  const controlFigures = figuresOf(controlEntry);
  const naiveFigures = naiveEntries.map(figuresOf);
  const medians = medianFigures(naiveFigures);
  if (HEADLINE_FIELDS.some((field) => !finite(medians[field]))) {
    return { published: false, reasons: ['naive-refused'] };
  }
  const reading = medians.peerFractionAggregate >= 0.60 || medians.hostUploadMultiplier <= 1.5
    ? 'strong' : 'poor';
  return {
    published: true,
    figures: { control: controlFigures, naive: naiveFigures },
    medians,
    controlAggregate: controlFigures.peerFractionAggregate,
    reading,
  };
}

export { GATE_REASONS };
