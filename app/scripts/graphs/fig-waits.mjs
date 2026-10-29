import { WAITS } from './sources.mjs';
import {
  C,
  document,
  gridX,
  hbar,
  ledgerOrder,
  linearScale,
  median,
  run,
  select,
  setupLines,
  text,
} from './public-common.mjs';
export const ID = 'waits', KIND = 'supporting', TITLE = 'How long does a viewer wait?';
export function data(inputs) {
  const landing = select(inputs, WAITS.landings),
    join = select(inputs, WAITS.join),
    extra = select(inputs, WAITS.landings10);
  const landRuns = landing.map((r) => ({
    ...run(r, r.readings.landings?.start?.waitMs, 'starting together'),
    start: r.readings.landings?.start?.waitMs ?? null,
    seek: r.readings.landings?.seek?.waitMs ?? null,
  }));
  const joinRuns = join.map((r) => ({
    ...run(r, r.readings['event-clocks']?.join?.entryToInSyncMs, 'joining late'),
    ...r.readings['event-clocks']?.join,
  }));
  const extraRuns = extra.map((r) => ({
    ...run(r, r.readings.landings?.start?.waitMs, '10 viewers'),
    start: r.readings.landings?.start?.waitMs ?? null,
    seek: r.readings.landings?.seek?.waitMs ?? null,
  }));
  const bars = [{ label: 'starting together', value: median(landRuns.map((r) => r.start)), runs: landRuns }, {
    label: 'jumping to a new point',
    value: median(landRuns.map((r) => r.seek)),
    runs: landRuns,
  }, { label: 'joining late', value: median(joinRuns.map((r) => r.entryToInSyncMs)), runs: joinRuns }];
  return {
    bars,
    landRuns,
    joinRuns,
    extraRuns,
    runs: ledgerOrder(inputs, [...landRuns, ...joinRuns]),
    regimes: [...landing, ...join].map((r) => ({
      label: r.entry.condition === WAITS.join ? 'joining late' : 'starting and jumping',
      regime: r.regime,
    })),
  };
}
const seconds = (n) => {
  return n == null ? 'unrecorded' : `${(n / 1000).toFixed(1)} s`;
};
export const takeaway = (d) => {
  return `With ${d.regimes[0].regime.viewers} viewers, the video was playing for everyone about ${
    seconds(d.bars[0].value)
  } after pressing play and ${
    seconds(d.bars[1].value)
  } after jumping to a new point; someone joining late was playing in step after ${
    seconds(d.bars[2].value)
  }.`;
};
export function svg(d) {
  const L = 230,
    R = 640,
    T = 30,
    bottom = T + 56 * d.bars.length,
    top = Math.max(6000, ...d.bars.map((b) => b.value).filter(Number.isFinite)),
    x = linearScale([0, top], [L, R]);
  let body = gridX(x, Array.from({ length: 7 }, (_, i) => top * i / 6), T - 10, bottom, (v) => v / 1000);
  d.bars.forEach((b, i) => {
    const y = T + i * 56 + 8;
    if (Number.isFinite(b.value)) {
      body += hbar({
        x0: L,
        x1: x(b.value),
        y,
        h: 24,
        fill: C.blue,
        title: `${b.label}: ${b.value / 1000} seconds`,
      });
    }
    body += text(L - 12, y + 17, b.label, { anchor: 'end', fill: C.ink });
    body += text(Number.isFinite(b.value) ? x(b.value) + 8 : L + 8, y + 17, seconds(b.value), {
      size: 14,
      fill: C.ink,
      weight: 600,
    });
  });
  body += text(L, bottom + 44, 'seconds until the video plays in step', { size: 14, fill: C.muted });
  return document({ width: 680, height: bottom + 60, title: TITLE, body });
}
export const notes = (d) => {
  return `**In one sentence.** ${
    takeaway(d)
  }\n\n**What the chart shows.** The middle wait until playback is in step.\n\n**How it was tested.** ${
    setupLines(d.regimes).join(' ')
  }\n\n**Every test.**\n\n| Test | Waits | Freezes | Status |\n| --- | --- | --- | --- |\n${
    [
      ...d.landRuns.map((r, i) =>
        `| Starting and jumping ${i + 1} | Start ${seconds(r.start)}; jump ${seconds(r.seek)} | ${
          r.stalls ?? 'unrecorded'
        } | ${r.status} |`
      ),
      ...d.joinRuns.map((r, i) =>
        `| Joining ${i + 1} | Open to first picture ${
          seconds(r.entryToFirstFrameMs)
        }; first picture to in step ${seconds(r.firstFrameToInSyncMs)}; open to in step ${
          seconds(r.entryToInSyncMs)
        } | ${r.stalls ?? 'unrecorded'} | ${r.status} |`
      ),
      ...d.extraRuns.map((r, i) =>
        `| 10 viewers ${i + 1} | Start ${seconds(r.start)}; jump ${seconds(r.seek)} | ${
          r.stalls ?? 'unrecorded'
        } | ${r.status} |`
      ),
    ].join('\n')
  }`;
};
