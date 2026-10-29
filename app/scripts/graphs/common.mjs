import { labelOf } from './sources.mjs';

export function records(inputs) {
  return Object.values(inputs.nights).flatMap((night) =>
    (night.verdicts.entries ?? []).map((entry) => {
      const ledger = night.ledger.runs.find((item) => item.directory === entry.directory) ?? {};
      return {
        entry,
        ledger,
        label: labelOf(ledger),
        run: inputs.runs[entry.directory] ?? {},
        readings: night.readings.runs[entry.directory] ?? {},
        className: night.classes[entry.condition],
      };
    })
  );
}
export function min(values) {
  const v = Object.values(values ?? {}).filter(Number.isFinite);
  return v.length ? Math.min(...v) : null;
}
export function sum(values) {
  const v = Object.values(values ?? {});
  return v.length && v.every(Number.isFinite) ? v.reduce((a, b) => a + b, 0) : null;
}
