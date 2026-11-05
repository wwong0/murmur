// Recovery from a capacity schedule's rise. Spans run from the
// rise's read-back at the risen capacity, each on the steady test's legs and on
// every viewer holding more than the registered figure ahead at the span's end.

import { parseRate } from '../../harness/apply-qdisc.mjs';
import { recoverySpans, recoveryTime } from './control-figures.mjs';
import { heldAheadAt } from './poll-coverage.mjs';

const finite = (value) => Number.isFinite(value);

export function heldAheadLeg(viewerPolls, tags, atMs, aheadMsMin) {
  const byClient = heldAheadAt(viewerPolls, tags, atMs);
  return { byClient, bar: finite(aheadMsMin) ? aheadMsMin : null,
    pass: finite(aheadMsMin) && tags.length > 0 && tags.every((tag) => byClient[tag] !== null && byClient[tag] > aheadMsMin) };
}

export function scheduleRecovery({ input = {}, schedule = input.capacitySchedule, spanMs = input.condition?.reading?.spanMs ?? 60_000,
  aheadMsMin = input.condition?.reading?.aheadMsMin, recordingEnd, spansOf = recoverySpans } = {}) {
  if (!schedule) return null;
  if (schedule.drop?.inForce === false || (schedule.rise && schedule.rise.inForce === false)) return { notInForce: true, edge: schedule.edge ?? null };
  const dropAt = schedule.drop?.readBackAtMs;
  const riseAt = schedule.rise?.readBackAtMs;
  if (!finite(dropAt) || !finite(riseAt)) throw new Error('capacity schedule records no drop or no rise read-back');
  if (riseAt < dropAt) throw new RangeError(`capacity schedule records its rise at ${riseAt} before its drop at ${dropAt}`);
  if (schedule.exercised !== true) return { notExercised: true, edge: schedule.edge ?? null };
  const tags = input.declaredClientTags ?? Object.keys(input.clients ?? {});
  const declaredEnd = riseAt + (input.condition?.capacitySchedule?.recordAfterRiseMs ?? Infinity);
  const result = spansOf({ input, transition: riseAt, recordingEnd: Math.min(recordingEnd, declaredEnd), spanMs,
    edgeSegments: input.condition?.reading?.spanEdgeSegments ?? 1, bars: input.condition?.bars,
    capacityBitsPerSecond: parseRate(schedule.rise.declared?.params?.rate) });
  const spans = result.spans.map((span) => {
    const legs = { ...span.legs, heldAhead: heldAheadLeg(input.viewerPolls, tags, span.window.endMs, aheadMsMin) };
    return { ...span, legs, pass: span.incomplete !== true && Object.values(legs).every((entry) => entry.pass === true),
      failedLegs: Object.entries(legs).filter(([, entry]) => entry.pass !== true).map(([name]) => name) };
  });
  return { notExercised: false, edge: schedule.edge, riseAtMs: riseAt, spanMs, spans, trailingMs: result.trailingMs,
    result: recoveryTime(spans, spanMs) };
}
