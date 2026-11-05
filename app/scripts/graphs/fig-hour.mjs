import { HOUR } from './sources.mjs';
import { C, document, gridY, linearScale, pct, run, select, setupLines, statusOf, text } from './public-common.mjs';
import { stackedColumn, swatch } from './svg.mjs';
import { peerBytesTrace } from './peer-bytes-trace.mjs';
export const ID = 'hour', KIND = 'supporting', TITLE = 'Where does the video come from over an hour?';
export function data(inputs) {
  const row = select(inputs, '13f-w-long').find((r) => r.entry.directory === HOUR),
    attempts = select(inputs, '13f-w-long'),
    trace = peerBytesTrace({ manifest: row.run.manifest, peerBytesByClient: inputs.traces.hour, binWidth: 60000 });
  const current = run(row, row.entry.figures?.peerFractionAggregate, 'hour-long test');
  if (current.stalls !== 0) {
    throw new Error('takeaway-unsupported:hour');
  }
  return {
    bins: trace.bins,
    marks: trace.marks,
    share: current.value,
    runs: [current],
    attempt: attempts.filter((r) => r.entry.directory !== HOUR).map((r) => run(r, null, 'earlier attempt')),
    uploadReason: statusOf(row, row.entry.figures?.hostUploadMultiplier ?? null),
    regimes: [{ label: 'hour-long test', regime: row.regime }],
  };
}
export const takeaway = (d) => {
  return `Over an hour of ${d.regimes[0].regime.viewers} people watching, ${
    pct(d.share)
  } of the video the viewers received came from each other, and nobody froze (${d.runs[0].stalls} freezes).`;
};
export function svg(d) {
  const W = 680,
    H = 400,
    L = 70,
    R = 650,
    T = 40,
    B = 320,
    rows = d.bins.map((b) => ({
      host: b.hostBytes * 8 / 60 / 1e6,
      peers: Object.values(b.peerBytesBySender).reduce((a, v) => a + v, 0) * 8 / 60 / 1e6,
    })),
    top = Math.max(1, Math.ceil(Math.max(...rows.map((r) => r.host + r.peers)) / 5) * 5),
    y = linearScale([0, top], [B, T]),
    x = linearScale([0, rows.length], [L, R]);
  let body = `<rect x="${L.toFixed(2)}" y="${T.toFixed(2)}" width="${
    Math.max(0, x((d.marks.warmupEnd - d.bins[0].startMs) / 60000) - L).toFixed(2)
  }" height="${(B - T).toFixed(2)}" fill="${C.band}"/>`;
  body += gridY(
    y,
    Array.from({ length: 6 }, (_, i) => top * i / 5),
    L,
    R,
  );
  const bw = (R - L) / rows.length;
  rows.forEach((r, i) => {
    body += stackedColumn({
      x: L + i * bw + 0.5,
      y: y(r.host),
      width: Math.max(1, bw - 1),
      height: y(0) - y(r.host),
      fill: C.gray,
      title: `minute ${i + 1}, from the sharer: ${r.host.toFixed(1)} Mbit/s`,
    });
    body += stackedColumn({
      x: L + i * bw + 0.5,
      y: y(r.host + r.peers),
      width: Math.max(1, bw - 1),
      height: Math.max(0, y(r.host) - y(r.host + r.peers) - 1),
      fill: C.blue,
      title: `minute ${i + 1}, from other viewers: ${r.peers.toFixed(1)} Mbit/s`,
    });
  });
  for (let t = 0; t <= rows.length; t += 10) {
    body += text(x(t), B + 22, t, { anchor: 'middle', size: 14, fill: C.muted });
  }
  body += text((L + R) / 2, B + 44, 'minutes into the test', { anchor: 'middle', size: 14, fill: C.muted });
  body += swatch(L, H - 24, C.gray, 'from the sharer');
  body += swatch(L + 170, H - 24, C.blue, 'from other viewers');
  body += text(15, 26, 'video received by all viewers, Mbit/s, per minute', { size: 14, fill: C.muted });
  return document({ width: W, height: H, title: TITLE, body });
}
export const notes = (d) => {
  return `**In one sentence.** ${takeaway(d)}\n\n` +
    '**What the chart shows.** The downloads completed in each minute, grouped by where they came from.\n\n' +
    `**How it was tested.** ${setupLines(d.regimes).join(' ')}\n\n` +
    '**Every test.**\n\n| Test | Share from viewers | Freezes | Status |\n| --- | --- | --- | --- |\n' +
    `| Hour-long test | ${pct(d.share)} | ${d.runs[0].stalls} | ${d.runs[0].status} |\n` +
    `${
      d.attempt.map((r) => `| Earlier attempt | no value | ${r.stalls ?? 'unrecorded'} | ${r.status} |`).join(
        '\n',
      )
    }\n\n` +
    `The earlier attempt did not count. The sharer's upload was not scored because ${d.uploadReason}.`;
};
