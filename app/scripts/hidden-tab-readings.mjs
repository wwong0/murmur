// scripts/hidden-tab-readings.mjs
//
// The hidden-tab probe, read: the run's validity, what each hide stopped, and the pass rule.
// Pure — the driver (`probe-hidden-tab.mjs`) hands it samples, page events and its own marks.
// Rules fixed before the first run.
//
// Clocks: `atWallMs` and marks are the driver's Date.now(); `pageMs` and event times are the
// page's timeOrigin + now(). Element positions are currentTime-based observations of whether the
// element advanced, never a drift figure.

export const HIDDEN_TICK_RATIO_MAX = 0.5;
export const MIN_HIDDEN_SPAN_MS = 3000;
export const EVENT_SLACK_MS = 250;
export const VISIBLE_SETTLE_MS = 2000;
export const REACH_WINDOW_MS = 10_000;
export const REACH_HOLD_SAMPLES = 3;
export const WITHIN_REACH_MODES = Object.freeze(['correcting', 'declining', 'settled', 'resolution-budget-hold']);

/** Hides from the driver's marks, in order: hide-start, hidden, return-start, visible. */
export function hideWindows(marks) {
  const windows = [];
  let open = null;
  for (const mark of marks) {
    if (mark.name === 'hide-start') open = { subject: mark.subject, hideStartMs: mark.atWallMs };
    else if (open && mark.name === 'hidden') open.hiddenMs = mark.atWallMs;
    else if (open && mark.name === 'return-start') open.returnStartMs = mark.atWallMs;
    else if (open && mark.name === 'visible') {
      open.visibleMs = mark.atWallMs;
      if (![open.hiddenMs, open.returnStartMs].every(Number.isFinite)) throw new Error('hideWindows: a hide is missing a mark');
      windows.push(open);
      open = null;
    }
  }
  if (open) throw new Error('hideWindows: a hide never returned');
  return windows;
}

const okSamples = (samples, page) => samples.filter((s) => s.page === page && s.ok === true);
const between = (samples, fromMs, toMs) => samples.filter((s) => s.atWallMs > fromMs && s.atWallMs < toMs);

/** Ticks per second between the first and last sample of `list`, by the page clock; null under two samples. */
export function tickRate(list) {
  if (list.length < 2) return null;
  const spanMs = list.at(-1).pageMs - list[0].pageMs;
  if (!(spanMs > 0)) return null;
  return ((list.at(-1).ticks - list[0].ticks) * 1000) / spanMs;
}

function callbackRate(list) {
  if (list.length < 2) return null;
  const spanMs = list.at(-1).pageMs - list[0].pageMs;
  return spanMs > 0 ? ((list.at(-1).callbacks - list[0].callbacks) * 1000) / spanMs : null;
}

/**
 * The validity rule. The subject's own visibility log reads hidden for the whole hide and visible
 * outside it, the other page never changes, and the subject's hidden tick rate is at most
 * HIDDEN_TICK_RATIO_MAX of its visible rate over the steady stretch before the first hide.
 */
//
// `audible` (H2, post-result): Chrome keeps an audible page's
// timers, so the tick condition becomes "no frame callback while hidden"; Q and H1 prove the regime.
export function validateRun({ samples, events, windows, steadyFromMs, subject, other, audible = false }) {
  const reasons = [];
  if (windows.length === 0) reasons.push('no hide');
  const subjectSamples = okSamples(samples, subject);
  const otherSamples = okSamples(samples, other);
  const changes = (page) => events.filter((e) => e.page === page && e.type === 'visibilitychange');
  const subjectChanges = changes(subject);
  if (changes(other).length !== 0) reasons.push(`${other} visibility changed`);
  if (otherSamples.some((s) => s.visibility !== 'visible')) reasons.push(`${other} sampled not visible`);
  if (subjectChanges.length !== windows.length * 2) reasons.push(`subject visibility changes ${subjectChanges.length}, expected ${windows.length * 2}`);
  windows.forEach((w, index) => {
    const hidden = subjectChanges[index * 2];
    const shown = subjectChanges[index * 2 + 1];
    if (hidden?.state !== 'hidden' || !(hidden.pageMs >= w.hideStartMs - EVENT_SLACK_MS && hidden.pageMs <= w.hiddenMs + EVENT_SLACK_MS)) reasons.push(`hide ${index + 1}: no hidden event at the hide`);
    if (shown?.state !== 'visible' || !(shown.pageMs >= w.returnStartMs - EVENT_SLACK_MS && shown.pageMs <= w.visibleMs + EVENT_SLACK_MS)) reasons.push(`hide ${index + 1}: no visible event at the return`);
  });
  for (const s of subjectSamples) {
    const inside = windows.find((w) => s.atWallMs >= w.hideStartMs && s.atWallMs <= w.visibleMs + VISIBLE_SETTLE_MS);
    const surely = windows.find((w) => s.atWallMs > w.hiddenMs + EVENT_SLACK_MS && s.atWallMs < w.returnStartMs);
    if (surely && s.visibility !== 'hidden') reasons.push(`subject sampled ${s.visibility} inside hide ${windows.indexOf(surely) + 1}`);
    if (!inside && s.visibility !== 'visible') reasons.push(`subject sampled ${s.visibility} outside every hide`);
  }
  const visibleRate = windows.length ? tickRate(between(subjectSamples, steadyFromMs, windows[0].hideStartMs)) : null;
  const hiddenRates = windows.map((w) => {
    const list = between(subjectSamples, w.hiddenMs, w.returnStartMs);
    const spanMs = list.length >= 2 ? list.at(-1).pageMs - list[0].pageMs : 0;
    return spanMs >= MIN_HIDDEN_SPAN_MS ? tickRate(list) : null;
  });
  if (!(visibleRate > 0)) reasons.push('no visible tick rate');
  const hiddenCallbacks = windows.map((w) => {
    const list = between(subjectSamples, w.hiddenMs, w.returnStartMs);
    return list.length >= 2 ? list.at(-1).callbacks - list[0].callbacks : null;
  });
  hiddenRates.forEach((rate, index) => {
    if (rate === null) reasons.push(`hide ${index + 1}: hidden span under ${MIN_HIDDEN_SPAN_MS} ms`);
    else if (audible) {
      if (hiddenCallbacks[index] !== 0) reasons.push(`hide ${index + 1}: ${hiddenCallbacks[index]} frame callbacks while hidden`);
    } else if (visibleRate > 0 && rate > HIDDEN_TICK_RATIO_MAX * visibleRate) reasons.push(`hide ${index + 1}: ticks ${rate.toFixed(2)}/s hidden against ${visibleRate.toFixed(2)}/s visible`);
  });
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], visibleTickRate: visibleRate, hiddenTickRates: hiddenRates, hiddenCallbacks, audible };
}

/** One sample is within the rate's reach: a mode that names no difference beyond the budget, from fresh frames. */
export function withinReach(sample, previous) {
  return previous !== undefined
    && WITHIN_REACH_MODES.includes(sample.controller?.mode)
    && Number.isFinite(sample.controller?.estimateMs)
    && sample.callbacks > previous.callbacks;
}

/** The first instant after `fromMs` that starts REACH_HOLD_SAMPLES consecutive within-reach samples. */
export function landedAtMs(list, fromMs) {
  for (let i = 1; i + REACH_HOLD_SAMPLES - 1 < list.length; i += 1) {
    if (list[i].atWallMs < fromMs) continue;
    let held = true;
    for (let k = 0; k < REACH_HOLD_SAMPLES; k += 1) held &&= withinReach(list[i + k], list[i + k - 1]);
    if (held) return list[i].atWallMs;
  }
  return null;
}

const range = (values) => (values.length ? { min: Math.min(...values), max: Math.max(...values) } : null);
const finite = (values) => values.filter(Number.isFinite);

/**
 * What one hide stopped, for the subject page: playback, frames, loading, the clock, membership —
 * and what the return did, read until `untilMs` (the next hide, or the run's end).
 */
export function readHide({ samples, events, window: w, subject, other, untilMs }) {
  const list = okSamples(samples, subject);
  const before = between(list, -Infinity, w.hideStartMs).at(-1) ?? null;
  const hidden = between(list, w.hiddenMs, w.returnStartMs);
  const after = between(list, w.visibleMs, untilMs);
  const first = hidden[0] ?? null;
  const last = hidden.at(-1) ?? null;
  const spanMs = first && last ? last.pageMs - first.pageMs : null;
  const elementAdvanceMs = first && last && Number.isFinite(first.elementMediaMs) && Number.isFinite(last.elementMediaMs)
    ? last.elementMediaMs - first.elementMediaMs : null;
  const elementEvents = events.filter((e) => e.page === subject && e.target === 'video' && e.pageMs > w.hideStartMs && e.pageMs < w.returnStartMs);
  const count = (type) => elementEvents.filter((e) => e.type === type).length;
  const atVisible = after[0] ?? null;
  const skipsAfter = after.length && before ? after.at(-1).skips - (last ?? before).skips : 0;
  const firstSkip = after.find((s) => s.skips > (last ?? before)?.skips);
  const landed = landedAtMs([...(before ? [before] : []), ...hidden, ...after], w.visibleMs);
  const otherRoster = okSamples(samples, other).filter((s) => s.atWallMs > w.hiddenMs && s.atWallMs < w.returnStartMs).map((s) => s.roster);
  return {
    hiddenSpanMs: spanMs,
    samples: hidden.length,
    playback: {
      pausedSamples: hidden.filter((s) => s.video?.paused === true).length,
      pausedAtReturn: last?.video?.paused ?? null,
      pausedAtVisible: atVisible?.video?.paused ?? null,
      roomPlayingThroughout: hidden.every((s) => s.roomPlaying === true),
      elementAdvanceMs,
      elementAdvanceRatio: spanMs > 0 && elementAdvanceMs !== null ? elementAdvanceMs / spanMs : null,
      gapBeforeMs: before?.positionGapMs ?? null,
      gapAtReturnMs: last?.positionGapMs ?? null,
      gapAtVisibleMs: atVisible?.positionGapMs ?? null,
      events: { pause: count('pause'), play: count('play'), playing: count('playing'), waiting: count('waiting'), stalled: count('stalled') },
      readyState: range(finite(hidden.map((s) => s.video?.readyState))),
    },
    frames: { callbacks: first && last ? last.callbacks - first.callbacks : null, rate: callbackRate(hidden) },
    tick: { rate: tickRate(hidden) },
    loading: {
      bufferedAheadMs: range(finite(hidden.map((s) => s.video?.bufferedAheadMs))),
      bufferedAheadAtReturnMs: last?.video?.bufferedAheadMs ?? null,
      receipts: first && last ? last.receipts.count - first.receipts.count : null,
      bytes: first && last ? last.receipts.bytes - first.receipts.bytes : null,
    },
    clock: {
      probesIssued: first && last ? last.clock.probesIssued - first.clock.probesIssued : null,
      ageMs: range(finite(hidden.map((s) => s.clock?.ageMs))),
      sampleCount: range(finite(hidden.map((s) => s.clock?.sampleCount))),
    },
    controller: {
      modes: [...new Set(hidden.map((s) => s.controller?.mode))],
      rate: range(finite(hidden.map((s) => s.controller?.rate))),
    },
    membership: { subjectRoster: range(finite(hidden.map((s) => s.roster))), otherRoster: range(finite(otherRoster)) },
    afterReturn: {
      skips: skipsAfter,
      firstSkipAfterVisibleMs: firstSkip ? firstSkip.atWallMs - w.visibleMs : null,
      abandonedMs: firstSkip?.lastSkipAbandonedMs ?? null,
      landedAfterVisibleMs: landed === null ? null : landed - w.visibleMs,
    },
  };
}

/** A whole run, from what the driver retains: validity, readings per hide, and the pass rule on the right side. */
export function evaluateRun({ samples, events, marks, subject, other, side, mustSkipReturn = null, audible = false }) {
  const windows = hideWindows(marks);
  const steadyFromMs = marks.find((m) => m.name === 'steady')?.atWallMs ?? null;
  const endMs = marks.find((m) => m.name === 'end')?.atWallMs ?? Infinity;
  const validity = validateRun({ samples, events, windows, steadyFromMs, subject, other, audible });
  const readings = windows.map((w, index) => readHide({ samples, events, window: w, subject, other, untilMs: windows[index + 1]?.hideStartMs ?? endMs }));
  const span = okSamples(samples, subject).filter((s) => steadyFromMs !== null && windows[0] && s.atWallMs > steadyFromMs && s.atWallMs < windows[0].hideStartMs);
  const visible = { tickRate: tickRate(span), callbackRate: callbackRate(span) };
  const d7 = side === 'right' ? readings.map((reading, index) => returnLanding(reading, { mustSkip: mustSkipReturn === index + 1 })) : null;
  return { windows, validity, visible, readings, d7, returnsPass: d7 ? d7.every((r) => r.pass) : null };
}

/**
 * The pass rule for one return: landed within REACH_WINDOW_MS of becoming visible, at most one skip.
 * `mustSkip` is H3's second return, which must skip where the left side's did not.
 */
export function returnLanding(reading, { mustSkip = false } = {}) {
  const reasons = [];
  const landed = reading.afterReturn.landedAfterVisibleMs;
  if (landed === null || landed > REACH_WINDOW_MS) reasons.push(`landed ${landed === null ? 'never' : `${landed} ms`} after visible`);
  if (reading.afterReturn.skips > 1) reasons.push(`${reading.afterReturn.skips} skips`);
  if (mustSkip && reading.afterReturn.skips < 1) reasons.push('no skip where one was required');
  return { pass: reasons.length === 0, reasons };
}
