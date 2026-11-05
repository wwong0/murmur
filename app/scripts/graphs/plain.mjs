import { runMark } from './rules.mjs';

export const BANNED = /\b(arm|scheme|8b|R0|c0\d|13[a-g]\w*|D\d+|window|condition)\b/i;
export const REASONS = {
  'status:aborted': 'the test stopped before it finished',
  'status:refused': "the test's own checks refused it",
  'status:running': 'the test did not finish recording',
  'exit-unobserved': 'the test was stopped by hand',
  'reader:byte-inventory': "the byte count could not be checked against the viewers' records",
  'reader:lab-drift': 'the timing records could not be read',
  'reader:gap-count': 'the timing records could not be read',
  'one-viewing-unavailable': "a viewer stopped playing, so there is no fair 'one viewing' to divide by",
  'steady-state-utilisation':
    "the sharer's connection was full, so the figure would measure the connection, not the sharing",
  'steady-state-cap-used': 'the pacing check could not be completed',
  'steady-state-download-ratio': 'a viewer was not downloading at the pace it played',
  'waits:value-missing': 'a wait was not recorded',
};
export function reasonText(entry, value) {
  const mark = runMark(entry, value);
  if (mark.filled) {
    return 'completed';
  }
  // An invalid run's own reasons lead; a refused multiplier must not hide them.
  const refusal = value == null ? entry.figures?.hostUploadMultiplierRefusal?.reason : null;
  const own = !entry.valid && entry.reasons?.length ? entry.reasons : [];
  const reasons = [...own, ...(refusal ? [refusal] : [])];
  if (!reasons.length) {
    reasons.push(entry.reasons?.length ? entry.reasons : entry.status ? `status:${entry.status}` : mark.reason);
  }
  return [...new Set(reasons.flat().map((reason) => {
    const code = String(reason).split(':', 2).join(':');
    return REASONS[code] ??
      (code.startsWith('refusal:')
        ? "the test's own checks refused it"
        : `excluded by an automatic check (${code})`);
  }))].join('; ');
}
export function conditionWords(regime) {
  const values = regime.lossDelay;
  if (values === 'none') {
    return 'no network trouble';
  }
  if (!Array.isArray(values)) {
    throw new Error('unknown-netem');
  }
  const parsed = values.map((item) => /^(loss|delay) ([\d.]+%|[\d.]+ms) on (origin|client|c\d+)$/.exec(item));
  if (parsed.some((v) => !v)) {
    throw new Error('unknown-netem');
  }
  const [first] = parsed;
  if (
    parsed.length === 2 && parsed.every((v) => v[1] === first[1] && v[2] === first[2]) &&
    new Set(parsed.map((v) => v.at(-1))).size === 2 && parsed.some((v) => v.at(-1) === 'origin') &&
    parsed.some((v) => v.at(-1) === 'client')
  ) {
    return first[1] === 'loss'
      ? `${first[2]} of data lost`
      : `everyone ${first[2].replace('ms', ' ms')} delayed`;
  }
  if (parsed.length === 1 && first[1] === 'delay' && /^c\d+$/.test(first.at(-1))) {
    return `one viewer ${first[2].replace('ms', ' ms')} farther away`;
  }
  throw new Error('unknown-netem');
}
const minutes = (v) => {
  return typeof v === 'number' ? v / 60000 : 'unrecorded';
};
export function setupLines(regimes) {
  const rows = regimes.map((item) => item.regime ? item : { label: '', regime: item });
  if (!rows.length) {
    return [];
  }
  const describe = (r) => {
    return [
      `${r.viewers} viewers and the person sharing the video, each in their own browser on one test computer.`,
      String(r.viewerCaps).startsWith('every viewer ')
        ? `The sharer could upload at most ${r.hostCapMbps} megabits per second, and each viewer ${
          r.viewerCaps.slice('every viewer '.length)
        }.`
        : `The sharer could upload at most ${r.hostCapMbps} megabits per second; viewer upload limits were ${
          String(r.viewerCaps).replace(/c\d+/g, 'a viewer')
        }.`,
      r.downloadsShaped === false
        ? 'Downloads were not limited.'
        : `Downloads: ${r.downloadsShaped === 'unrecorded' ? 'unrecorded' : 'limited'}.`,
      r.lossDelay === 'none'
        ? 'No data was lost or delayed.'
        : r.lossDelay === 'unrecorded'
        ? 'Data loss and delay: unrecorded.'
        : `${conditionWords(r)}.`,
      `The video played at ${r.bitrateMbps} megabits per second.`,
      `Each test lasted ${minutes(r.durationMs)} minutes; the first ${
        minutes(r.prefixMs)
      } let things settle and the last ${minutes(r.windowMs)} were measured.`,
      `Video pieces were ${r.segmentSeconds} seconds long.`,
    ];
  };
  const all = rows.map(({ regime }) => describe(regime));
  const lines = all[0].flatMap((line, index) =>
    all.every((v) => v[index] === line)
      ? [line]
      : [...new Set(rows.map((row, i) =>
        all[i][index] === `${row.label}.` ? all[i][index] : `${row.label}: ${all[i][index]}`
      ))]
  );
  for (const label of new Set(rows.map((row) => row.label))) {
    const trips = rows.filter((row) => row.label === label).flatMap(({ regime }) =>
      String(regime.roundTripMs).split('–').map(Number).filter(Number.isFinite)
    );
    const trip = trips.length ? `${Math.min(...trips).toFixed(1)}–${Math.max(...trips).toFixed(1)} ms` : 'unrecorded';
    const count = rows.filter((row) => row.label === label).length;
    lines.push(`${label || 'This setup'}: ${count} tests; the round trip from each viewer to the room server was ${trip}.`);
  }
  return lines;
}
