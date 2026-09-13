// scripts/drift-browser-evidence.mjs
//
// The browser pass's retained-evidence round trip: the bar table it declares
// into a run manifest, and everything that reads a finished run directory back
// out of NDJSON.
//
// It is separate from verify-browser.mjs for the same reason drift-figures.mjs
// is: that file prepares its run directory and spawns Chrome at module top
// level, so nothing defined beside it can be imported and nothing in it is
// reachable from `npm run check`. Every function here runs on a manifest and a
// directory of records, so the sufficiency rule, the bar round trip and the
// median re-derivation are checkable without a browser.
//
// The bar table is DERIVED from `DEFAULT_BARS` rather than restated beside it.
// The hand-written table this replaces listed all eleven bars a second time and
// paired each with its units by hand, so a bar added next door reached the
// manifest only if someone remembered to come here. Now the manifest carries
// exactly the bars the figures module declares, and a bar with no declared unit
// is a refusal at load rather than an `undefined` in a retained manifest.

import fs from 'node:fs';
import path from 'node:path';

import { MAX_RATE_DEVIATION } from '../public/lib/drift-controller.mjs';
import { DEFAULT_BARS, convergedStats, steadyCommandStretches, stretchSlopes } from './drift-figures.mjs';

/** What each bar is measured in. Keyed by `DEFAULT_BARS`, and checked against it. */
const BAR_UNITS = Object.freeze({
  RATE_STEADY_TOLERANCE: 'dimensionless rate',
  STRETCH_EDGE_EXCLUSION_MS: 'ms',
  MIN_STRETCH_SPAN_MS: 'ms',
  MIN_STRETCH_RECORDS: 'count',
  MIN_RESIDUAL_SPAN_MS: 'ms',
  MIN_RESIDUAL_RECORDS: 'count',
  MAX_STRETCH_SLOPE_SE_PPM: 'ppm',
  MAX_RESIDUAL_SLOPE_SE_PPM: 'ppm',
  SLOPE_SIGNIFICANCE_SIGMA: 'dimensionless',
  RESIDUAL_FLOOR_PPM: 'ppm',
  ENDPOINT_CROSSCHECK_MS: 'ms',
});

/** The `bars` block of a run manifest: every declared bar, with its unit. */
export const BAR_DEFINITIONS = Object.freeze(Object.fromEntries(
  Object.entries(DEFAULT_BARS).map(([name, value]) => {
    const units = BAR_UNITS[name];
    if (units === undefined) throw new Error(`bar ${name} has no declared units`);
    return [name, { value, units }];
  }),
));

export function readNdjson(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (text === '') return [];
  return text.split(/\r?\n/).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid NDJSON at ${filePath}:${index + 1}: ${error.message}`);
    }
  });
}

export function barsFromManifest(manifest) {
  const bars = Object.fromEntries(Object.entries(manifest.bars ?? {}).map(([name, definition]) => [name, definition.value]));
  for (const name of Object.keys(DEFAULT_BARS)) {
    if (!Number.isFinite(bars[name])) throw new Error(`manifest is missing bar ${name}`);
  }
  return bars;
}

export function qualifyingFit(fit, minimumRecords, minimumSpanMs, standardErrorPpm) {
  return !fit.refused
    && fit.recordCount >= minimumRecords
    && fit.trimmedSpanMs >= minimumSpanMs
    && Number.isFinite(fit.media?.standardErrorPpm)
    && fit.media.standardErrorPpm <= standardErrorPpm
    && Number.isFinite(fit.drift?.standardErrorPpm)
    && fit.drift.standardErrorPpm <= standardErrorPpm
    && fit.endpointCrosscheck?.mediaWithinBar === true
    && fit.endpointCrosscheck?.driftWithinBar === true;
}

/**
 * Whether the run retained enough to support the residual figures, read back
 * from the manifest and the NDJSON it names. `runDir` is a parameter because the
 * window file paths in a manifest are relative to the directory that produced
 * it, which is the run being read and not the process doing the reading.
 */
export function evaluateSufficiency(manifestPath, runDir) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const bars = barsFromManifest(manifest);
  const windows = (manifest.windows ?? []).map((window) => {
    const records = readNdjson(path.join(runDir, window.files.records));
    const captures = readNdjson(path.join(runDir, window.files.captures));
    const samples = captures.map((capture) => ({ atMs: capture.atMs, ...capture.controller }));
    const stretches = steadyCommandStretches(samples, bars);
    const fits = stretchSlopes({ stretches, records, bars });
    const saturatedFits = fits.filter((fit) => qualifyingFit(
      fit,
      bars.MIN_STRETCH_RECORDS,
      bars.MIN_STRETCH_SPAN_MS,
      bars.MAX_STRETCH_SLOPE_SE_PPM,
    ) && Math.abs(fit.medianRate - (1 + MAX_RATE_DEVIATION)) <= bars.RATE_STEADY_TOLERANCE);
    const plateauFits = fits.filter((fit) => qualifyingFit(
      fit,
      bars.MIN_RESIDUAL_RECORDS,
      bars.MIN_RESIDUAL_SPAN_MS,
      bars.MAX_RESIDUAL_SLOPE_SE_PPM,
    ) && fit.medianRate < 1 + MAX_RATE_DEVIATION - bars.RATE_STEADY_TOLERANCE);
    const recordMinimumMet = records.length >= bars.MIN_RESIDUAL_RECORDS;
    const spanMinimumMet = plateauFits.length > 0;
    const missed = window.counts?.missed;
    const ok = missed === 0 && recordMinimumMet && spanMinimumMet && saturatedFits.length > 0 && plateauFits.length > 0;
    return {
      label: window.label,
      records: records.length,
      captures: captures.length,
      missed,
      stretches: fits.length,
      qualifyingSaturated: saturatedFits.length,
      qualifyingPlateau: plateauFits.length,
      recordMinimumMet,
      spanMinimumMet,
      ok,
    };
  });
  return { ok: windows.length === 2 && windows.every((window) => window.ok), windows };
}

/**
 * The converged median, recomputed from the records the run kept rather than
 * from the figure it printed. A retained file that cannot supply the sequence
 * numbers the bounds are expressed in is refused, never silently narrowed.
 */
export function rederiveConvergedMedian(recordsPath, barSeq, endSeq) {
  if (!Number.isSafeInteger(barSeq) || !Number.isSafeInteger(endSeq) || endSeq < barSeq) {
    throw new Error(`invalid retained median bounds ${barSeq}..${endSeq}`);
  }
  const records = readNdjson(recordsPath);
  if (!records.every((record) => record && Number.isSafeInteger(record.seq))) {
    throw new Error(`retained records in ${recordsPath} do not all have sequence numbers`);
  }
  const selected = records.filter((record) => record.seq > barSeq && record.seq <= endSeq);
  const result = convergedStats({ records: selected }, barSeq);
  return { medianMs: result.convergedMedianMs, count: result.convergedCount };
}
