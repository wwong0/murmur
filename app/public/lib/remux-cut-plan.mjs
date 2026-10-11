function ensureKeyframes(keyframeTicks, endTick) {
  if (!Array.isArray(keyframeTicks) || keyframeTicks.length === 0) throw new RangeError('keyframeTicks must not be empty');
  for (let i = 0; i < keyframeTicks.length; i += 1) {
    if (!Number.isInteger(keyframeTicks[i]) || (i > 0 && keyframeTicks[i] <= keyframeTicks[i - 1])) {
      throw new RangeError('keyframeTicks must be strictly increasing integers');
    }
  }
  if (!Number.isInteger(endTick) || keyframeTicks.at(-1) >= endTick) throw new RangeError('last keyframe must be below endTick');
}

export function planCuts({ keyframeTicks, endTick, timescale, targetMs }) {
  ensureKeyframes(keyframeTicks, endTick);
  if (!Number.isInteger(timescale) || timescale <= 0 || !Number.isInteger(targetMs) || targetMs <= 0) {
    throw new RangeError('timescale and targetMs must be positive integers');
  }
  const boundaries = [...keyframeTicks, endTick];
  const segments = [];
  let start = 0;
  while (start < keyframeTicks.length) {
    let end = start + 1;
    while (end + 1 < boundaries.length && (boundaries[end + 1] - boundaries[start]) * 1000 <= targetMs * timescale) end += 1;
    segments.push({
      startTick: boundaries[start],
      endTick: boundaries[end],
      firstKeyframe: start,
      keyframeCount: end - start,
    });
    start = end;
  }
  return segments;
}

export function assignAudio({ segments, video, audio }) {
  const result = [];
  let from = 0;
  for (let i = 0; i < segments.length; i += 1) {
    if (i > 0) {
      const start = segments[i].startTick * audio.timescale;
      while (from < audio.dts.length && (audio.dts[from] + (audio.shift ?? 0)) * video.timescale < start) from += 1;
    }
    result.push({ from, to: i + 1 < segments.length ? from : audio.dts.length });
  }
  for (let i = 0; i + 1 < result.length; i += 1) result[i].to = result[i + 1].from;
  return result;
}
