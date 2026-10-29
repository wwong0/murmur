const present = (value) => value == null ? 'unrecorded' : value;
function rate(value) {
  const match = /^([\d.]+)\s*([km])bit$/i.exec(value ?? '');
  if (!match) return null;
  return Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1e6 : 1000) / 1e6;
}
export function regimeOf(run, ledgerEntry, figures) {
  const condition = run?.manifest?.condition ?? {};
  const content = run?.content ?? {};
  const qdiscs = condition.qdiscs;
  const tbf = (qdiscs ?? []).filter((row) => row.discipline === 'tbf');
  const origin = tbf.find((row) => row.container === 'origin');
  const viewers = tbf.filter((row) => row.container !== 'origin');
  const caps = viewers.map((row) => `${row.container} ${present(rate(row.params?.rate))} Mbit/s`);
  const uniform = viewers.find((row) => row.container === 'client');
  const netem = (qdiscs ?? []).filter((row) => row.discipline === 'netem');
  const impairments = netem.flatMap((row) => Object.entries(row.params ?? {}).map(([key, value]) => `${key} ${value} on ${row.container}`));
  const echoes = Object.values(figures?.echoRoundTripMsP50ByClient ?? {}).filter(Number.isFinite);
  return {
    build: ledgerEntry?.commit && ledgerEntry?.bundleBuildId ? `${ledgerEntry.commit} ${ledgerEntry.bundleBuildId}` : 'unrecorded',
    viewers: present(condition.clients), bitrateMbps: Number.isFinite(content.totalBytes) && content.duration > 0 ? (content.totalBytes * 8 / content.duration / 1e6).toFixed(2) : 'unrecorded',
    segmentSeconds: present(content.segmentSeconds), hostCapMbps: present(rate(origin?.params?.rate)),
    viewerCaps: !qdiscs ? 'unrecorded' : uniform && viewers.length === 1 ? `every viewer ${present(rate(uniform.params?.rate))} Mbit/s` : caps.length ? caps.join(', ') : 'unrecorded',
    downloadsShaped: qdiscs ? qdiscs.some((row) => row.direction !== 'egress') : 'unrecorded',
    lossDelay: qdiscs ? impairments.length ? impairments : 'none' : 'unrecorded',
    roundTripMs: echoes.length ? `${Math.min(...echoes).toFixed(1)}–${Math.max(...echoes).toFixed(1)}` : 'unrecorded',
    durationMs: present(condition.runLengthMs), prefixMs: present(condition.excludedPrefixMs), windowMs: present(condition.measureWindowMs),
  };
}
