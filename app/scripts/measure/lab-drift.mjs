import { median, percentile } from './stats.mjs';

const finite = (value) => Number.isFinite(value);
const pairName = (left, right) => `${left}|${right}`;

function refusal(run, reason, detail) {
  return { reader: 'lab-drift', version: 1, run, refused: true, reason, detail };
}

function labInstant(record) {
  return finite(record?.displaySharedMs) && finite(record?.clock?.offsetMs)
    ? record.displaySharedMs - record.clock.offsetMs : null;
}

function timebasePage(polls, valueFields, wallField) {
  const values = (polls ?? []).map((poll) => ({
    wall: poll?.[wallField],
    d: poll?.[valueFields[0]] - poll?.[valueFields[1]],
  })).filter((entry) => finite(entry.wall) && finite(entry.d));
  if (!values.length) return null;
  const byWall = values.slice().sort((a, b) => a.wall - b.wall);
  const firstWall = byWall[0].wall;
  const lastWall = byWall.at(-1).wall;
  const nearFirst = values.filter((entry) => entry.wall - firstWall <= 30_000);
  const nearLast = values.filter((entry) => lastWall - entry.wall <= 30_000);
  const d = median(values.map((entry) => entry.d));
  const first = median(nearFirst.map((entry) => entry.d));
  const last = median(nearLast.map((entry) => entry.d));
  return { d, first, last, movedMs: Math.abs(last - first), samples: values.length };
}

function timebaseCheck(evidence) {
  const pages = {};
  const missingViewer = [];
  for (const tag of evidence.tags) {
    const page = timebasePage(evidence.clients[tag]?.polls, ['atMs', 'wallMs'], 'wallMs');
    pages[tag] = page;
    if (!page) missingViewer.push(tag);
  }
  const host = timebasePage(evidence.hostPoll, ['pageMs', 'pageWallMs'], 'pageWallMs');
  pages.host = host;
  const values = Object.values(pages).filter(Boolean);
  const spreadMs = values.length ? Math.max(...values.map((page) => page.d)) - Math.min(...values.map((page) => page.d)) : null;
  const moved = values.length ? Math.max(...values.map((page) => page.movedMs)) : null;
  const status = missingViewer.length || !host ? 'unestablished'
    : spreadMs <= 2 && values.every((page) => page.movedMs <= 2) ? 'met' : 'failed';
  return { status, spreadMs, pages, missingViewer, maxMovedMs: moved };
}

function nearest(records, instant, halfStep) {
  let best = null;
  for (const record of records) {
    const distance = Math.abs(record.L - instant);
    if (!best || distance < best.distance) best = { record, distance };
  }
  return best && best.distance <= halfStep ? best.record : null;
}

function recordsFor(evidence, tag) {
  return (evidence.clients[tag]?.drift ?? []).map((record) => ({ ...record, L: labInstant(record) }))
    .filter((record) => finite(record.L)).sort((a, b) => a.L - b.L);
}

function pairReading(left, right, records, grid, offsets, status, cadence) {
  const values = [];
  let missing = 0;
  let epochMismatch = 0;
  const step = grid.step;
  for (const instant of grid.instants) {
    const a = nearest(records[left], instant, step / 2);
    const b = nearest(records[right], instant, step / 2);
    if (!a || !b) {
      missing += 1;
      continue;
    }
    // The rig applies a declared offset by moving that viewer's epoch back by it.
    if (a.epochMs + (offsets[left] ?? 0) !== b.epochMs + (offsets[right] ?? 0)) {
      epochMismatch += 1;
      continue;
    }
    const alignedLeft = a.mediaMs - (offsets[left] ?? 0);
    const alignedRight = b.mediaMs - (offsets[right] ?? 0);
    values.push({
      g: alignedLeft - alignedRight,
      raw: a.mediaMs - b.mediaMs,
      record: a.driftMs - b.driftMs,
      hidden: alignedLeft - alignedRight - (a.driftMs - b.driftMs),
    });
  }
  const abs = values.map((value) => Math.abs(value.g));
  const absMedianMs = median(abs);
  const floorLeft = cadence?.[left]?.presentIntervalMs;
  const floorRight = cadence?.[right]?.presentIntervalMs;
  const floorMs = finite(floorLeft) && finite(floorRight)
    ? Math.max(floorLeft, floorRight) + (status === 'met' ? 2 : 0) : null;
  return {
    left,
    right,
    points: values.length,
    missing,
    epochMismatch,
    absMedianMs,
    absP99Ms: percentile(abs, 0.99),
    signedMedianMs: median(values.map((value) => value.g)),
    rawSignedMedianMs: median(values.map((value) => value.raw)),
    recordSignedMedianMs: median(values.map((value) => value.record)),
    hiddenClockMs: median(values.map((value) => value.hidden)),
    floorMs,
    lowerMs: finite(absMedianMs) && finite(floorMs) ? Math.max(0, absMedianMs - floorMs) : null,
    upperMs: finite(absMedianMs) && finite(floorMs) ? absMedianMs + floorMs : null,
  };
}

function gridFor(window, frameRate) {
  const step = 1000 / frameRate;
  const instants = [];
  for (let instant = window.startMs; instant < window.endMs; instant += step) instants.push(instant);
  return { step, instants };
}

export function labDrift(evidence) {
  const run = evidence?.run ?? null;
  const start = Date.parse(evidence?.manifest?.startedAt);
  const end = Date.parse(evidence?.manifest?.runEndedAt);
  if (!finite(start) || !finite(end)) return refusal(run, 'run-span-unavailable');
  const allRecords = evidence.tags.flatMap((tag) => (evidence.clients[tag]?.drift ?? []).map((record) => ({ tag, record, L: labInstant(record) })));
  const outside = allRecords.filter(({ L }) => finite(L) && (L < start - 5_000 || L > end + 5_000)).length;
  if (allRecords.length && outside / allRecords.length > 0.01) {
    return refusal(run, 'foreign-timebase', { outside, total: allRecords.length });
  }
  for (const tag of evidence.tags) {
    if (evidence.clients[tag]?.drift === null) return refusal(run, 'stream-missing', `drift:${tag}`);
    if (!evidence.clients[tag]?.drift?.length) return refusal(run, 'stream-empty', `drift:${tag}`);
  }
  const window = evidence.manifest?.window;
  if (!window || !finite(window.startMs) || !finite(window.endMs)) return refusal(run, 'window-unavailable');
  const frameRate = evidence.manifest?.content?.frameRate;
  if (!finite(frameRate) || frameRate <= 0) return refusal(run, 'frame-rate-unavailable');
  const check = timebaseCheck(evidence);
  const records = Object.fromEntries(evidence.tags.map((tag) => [tag, recordsFor(evidence, tag)]));
  const offsets = evidence.condition?.positionOffsetMsByClient ?? {};
  const grid = gridFor(window, frameRate);
  const pairs = [];
  const pooled = [];
  for (let left = 0; left < evidence.tags.length; left += 1) {
    for (let right = left + 1; right < evidence.tags.length; right += 1) {
      const pair = pairReading(evidence.tags[left], evidence.tags[right], records, grid, offsets, check.status, evidence.manifest?.cadence);
      pairs.push(pair);
      if (pair.points) pooled.push(...grid.instants.flatMap((instant) => {
        const a = nearest(records[pair.left], instant, grid.step / 2);
        const b = nearest(records[pair.right], instant, grid.step / 2);
        if (!a || !b || a.epochMs + (offsets[pair.left] ?? 0) !== b.epochMs + (offsets[pair.right] ?? 0)) return [];
        return [Math.abs((a.mediaMs - (offsets[pair.left] ?? 0)) - (b.mediaMs - (offsets[pair.right] ?? 0)))];
      }));
    }
  }
  const worst = pairs.filter((pair) => finite(pair.absMedianMs)).sort((a, b) => b.absMedianMs - a.absMedianMs)[0] ?? null;
  const medians = evidence.tags.map((tag) => median(records[tag].map((record) => record.clock?.offsetMs))).filter(finite);
  const overall = { absMedianMs: median(pooled), absP99Ms: percentile(pooled, 0.99), worstPair: worst ? pairName(worst.left, worst.right) : null };
  return {
    reader: 'lab-drift',
    version: 1,
    run,
    timeBasis: check.status === 'met' ? 'lab-time' : 'reconstructed-lab-time',
    timebaseCheck: check,
    window: { startMs: window.startMs, endMs: window.endMs, stepMs: grid.step, points: grid.instants.length },
    pairs,
    overall,
    absMedianMs: overall.absMedianMs,
    absP99Ms: overall.absP99Ms,
    worstPair: overall.worstPair,
    offsetSpreadMs: medians.length ? Math.max(...medians) - Math.min(...medians) : null,
  };
}
