import { secondBatchValidity } from './second-batch-verdicts.mjs';
import { figuresOf, multiplierVerdict, peerVerdict, readingOf } from './batch-verdicts.mjs';

const LIMIT_BYTES = 1_073_741_824;
const finite = (value) => Number.isFinite(value);

function viewerReading(viewer) {
  const peakStoredBytes = finite(viewer?.peakStoredBytes) ? viewer.peakStoredBytes : null;
  const storedBytes = finite(viewer?.storedBytes) ? viewer.storedBytes : null;
  const peakBasis = viewer?.peakBasis ?? null;
  const status = peakBasis !== 'store' || peakStoredBytes === null ? 'unestablished'
    : peakStoredBytes <= LIMIT_BYTES ? 'met' : 'missed';
  return { peakStoredBytes, peakBasis, status, storedBytes,
    limitActed: storedBytes === null ? null : storedBytes > LIMIT_BYTES };
}

function readingFor(entry, run, baseline) {
  const figures = figuresOf(run);
  const inventory = readingOf(run, 'byte-inventory');
  const tags = entry.clientTags ?? run.manifest?.declaredClientTags ?? Object.keys(inventory?.viewers ?? {});
  const viewers = Object.fromEntries(tags.map((tag) => [tag, viewerReading(inventory?.viewers?.[tag])]));
  // The harness nests evaluateRefusals' output under `refusal` in refusal-report.json.
  const counting = run.refusalReport?.refusal ?? {};
  const countedAsStall = counting.countedAsStall ?? [];
  const coverageFromPollsByClient = counting.published?.coverageFromPollsByClient ?? {};
  if (entry.condition === '13f-r0-five') return {
    viewers, countedAsStall, coverageFromPollsByClient,
    criterion2: multiplierVerdict(figures, 1.5), criterion3: peerVerdict(figures.peerFractionAggregate, 0.60),
  };
  const statuses = Object.values(viewers).map((viewer) => viewer.status);
  const gate = statuses.includes('missed') ? 'missed'
    : statuses.length && statuses.every((status) => status === 'met') ? 'met' : 'unestablished';
  const fields = ['stallCountByClient', 'realtimeFactorByClient', 'peerFractionAggregate'];
  const selected = (source) => Object.fromEntries(fields.map((key) => [key, source?.[key] ?? null]));
  return {
    viewers, gate, ...selected(figures), noFrameMsByClient: counting.published?.noFrameMsByClient ?? null,
    countedAsStall, coverageFromPollsByClient,
    besideSecondBatchW: { baseline: baseline === null ? null : selected(baseline), label: 'descriptive-invalid-run',
      buildDifference: "13f runs with 13e-2's urgent requests for a preparing viewer; 13e's W did not" },
  };
}

export function memoryLimitVerdicts({ entries = [], runs = {}, baseline = null } = {}) {
  const records = entries.map((entry) => {
    const run = runs[entry.directory] ?? {};
    const validity = secondBatchValidity(entry, run);
    const record = { directory: entry.directory ?? null, condition: entry.condition ?? null, ...validity };
    if (validity.valid && ['13f-w-long', '13f-r0-five'].includes(entry.condition)) {
      record.reading = readingFor(entry, run, baseline);
    }
    return record;
  });
  const counts = { valid: records.filter((record) => record.valid).length,
    invalid: records.filter((record) => !record.valid).length };
  for (const status of ['met', 'missed', 'unestablished']) {
    counts[status] = records.filter((record) => record.condition === '13f-w-long' && record.reading?.gate === status).length;
  }
  return { runs: records, counts };
}
