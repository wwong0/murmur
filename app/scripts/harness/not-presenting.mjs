export const POLL_EDGE_MS = 5_000;
export const POLL_GAP_MS = 5_000;
export const MIN_NO_FRAME_MS = 2_000;

export const STALL_COUNTED_REASONS = Object.freeze([
  'client-never-began-playback',
  'client-holds-no-drift-records',
  'client-did-not-start',
  'record-coverage-unavailable',
  'record-coverage-below-declared-fraction',
  'dropped-frame-evidence-unavailable',
  'client-cadence-unavailable',
  'peer-byte-control-unavailable',
  'origin-client-agreement-unavailable',
]);

export const STALL_COUNTED_CONTEXT_FIELDS = Object.freeze([
  'realtimeFactorByClient',
  'mediaAdvanceFactorByClient',
  'realtimeFactorFromFrameQualityByClient',
  'droppedFrameFractionByClient',
  'presentedFramesByClient',
  'coverageRatioByClient',
]);

const finite = (value) => Number.isFinite(value);

export function notPresenting(polls, window) {
  if (!finite(window?.startMs) || !finite(window?.endMs)) {
    return { recordingRan: false, why: ['window'], fromMs: null, noFrameMs: null, counted: false };
  }
  const inWindow = (Array.isArray(polls) ? polls : [])
    .filter((poll) => finite(poll?.atMs) && poll.atMs >= window.startMs && poll.atMs <= window.endMs);
  const why = [];
  if (inWindow.length < 2) why.push('fewer-than-two-polls');
  else {
    if (inWindow[0].atMs - window.startMs > POLL_EDGE_MS) why.push('first-poll-late');
    if (window.endMs - inWindow.at(-1).atMs > POLL_EDGE_MS) why.push('last-poll-early');
    if (inWindow.slice(1).some((poll, index) => poll.atMs - inWindow[index].atMs > POLL_GAP_MS)) why.push('poll-gap');
    let previous = -Infinity;
    if (inWindow.some((poll) => {
      const frames = poll.quality?.totalVideoFrames;
      const bad = !finite(frames) || frames < previous;
      previous = frames;
      return bad;
    })) why.push('frames');
    if (inWindow.some((poll) => !finite(poll.clock?.offsetMs))) why.push('clock');
    if (inWindow.some((poll) => poll.stalls?.epoch == null)
      || new Set(inWindow.map((poll) => poll.stalls?.epoch)).size !== 1) why.push('epoch');
  }
  let fromMs = window.startMs;
  for (let index = 1; index < inWindow.length; index += 1) {
    const before = inWindow[index - 1];
    const after = inWindow[index];
    if (before.playback?.playing === true && after.playback?.playing === true
      && after.quality?.totalVideoFrames > before.quality?.totalVideoFrames) fromMs = after.atMs;
  }
  const noFrameMs = window.endMs - fromMs;
  const recordingRan = why.length === 0;
  return { recordingRan, why, fromMs, noFrameMs, counted: recordingRan && noFrameMs >= MIN_NO_FRAME_MS };
}
