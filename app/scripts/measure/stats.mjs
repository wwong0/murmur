const finite = (value) => Number.isFinite(value);

function ordered(values) {
  return (Array.isArray(values) ? values : []).filter(finite).slice().sort((a, b) => a - b);
}

export function median(values) {
  const sorted = ordered(values);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentile(values, q) {
  const sorted = ordered(values);
  if (!sorted.length) return null;
  if (!finite(q)) return null;
  const fraction = Math.max(0, Math.min(1, q));
  const h = (sorted.length - 1) * fraction;
  const lower = Math.floor(h);
  const upper = Math.ceil(h);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (h - lower);
}

export function weightedPercentile(entries, q) {
  const values = (Array.isArray(entries) ? entries : [])
    .filter((entry) => Array.isArray(entry) && finite(entry[0]) && finite(entry[1]) && entry[1] >= 0)
    .map(([value, weight]) => [value, weight]).sort((a, b) => a[0] - b[0]);
  if (!values.length || !finite(q)) return null;
  const total = values.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0)) return null;
  const target = Math.max(0, Math.min(1, q)) * total;
  let cumulative = 0;
  for (const [value, weight] of values) {
    cumulative += weight;
    if (cumulative >= target) return value;
  }
  return values.at(-1)[0];
}
