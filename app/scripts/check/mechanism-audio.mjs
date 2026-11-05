// scripts/check/mechanism-audio.mjs
//
// The audio branch of the offline mechanism model: which fill-buffer mode a
// requested rate selects, what media advance that mode actually produces, and
// the clock that maps a media timestamp to a wall-clock instant.
//
// Ported from pinned Chromium 152.0.7977.76 revision
// 0d89dfa2dd7c1ec4b8a14b9f303f887bb63b6174 — `media/filters/
// audio_renderer_algorithm.cc` (`ChooseBufferMode`, `FillBuffer`),
// `media/filters/audio_clock.cc` (`WroteAudio`, `TimeUntilPlayback`) and
// `media/renderers/audio_renderer_impl.cc` (`GetWallClockTimes`).
// Hashes are in mechanism-model-report.md; this is a source-mapped model, not a
// build of Chromium and not proof of which path a browser took.
//
// THE ONE RULE THIS FILE EXISTS TO HOLD: a REQUESTED rate and an EFFECTIVE rate
// are different quantities and never overwrite each other. Media advance runs on
// the effective rate the mode reports (exactly 1 for the copy branch), while a
// timestamp past the end of buffered audio is projected at the REQUESTED rate —
// `GetWallClockTimes` divides by `playback_rate_`, not by the effective one.
// Collapsing them is the model error the whole experiment would be worthless to.
//
// TEST MACHINERY — under scripts/, never imported by the bundle. No randomness,
// no clock read: the caller supplies every instant.

/** `kOlaWindowSize` in audio_renderer_algorithm.cc. */
export const OLA_WINDOW_MS = 20;

/**
 * `AudioTimestampHelper::TimeToFrames` — ROUND, not truncate. The descriptive
 * helper in `scripts/rate-observation-model.mjs` floors instead; that helper is
 * left unchanged here, and the two agree at every sample rate whose
 * 20 ms window is a whole number of samples, which is all three swept here.
 */
export function timeToFrames(ms, sampleRate) {
  return Math.round((ms / 1000) * sampleRate);
}

/** The OLA window in samples, forced even exactly as `Initialize` does. */
export function olaWindowSamples(sampleRate) {
  const samples = timeToFrames(OLA_WINDOW_MS, sampleRate);
  return samples + (samples & 1);
}

/**
 * The open interval of rates the copy branch covers, derived rather than fitted.
 * `ceil(N/r) >= N` is `r < N/(N-1)`; `ceil(N*r) >= N` is `r > (N-1)/N`. Both
 * endpoints are EXCLUDED, so a rate exactly on one is a WSOLA rate.
 */
export function copyRegionBounds(sampleRate) {
  const windowSamples = olaWindowSamples(sampleRate);
  return {
    windowSamples,
    lowerOpenRate: (windowSamples - 1) / windowSamples,
    upperOpenRate: windowSamples / (windowSamples - 1),
  };
}

export const FILL_BUFFER_MODES = Object.freeze(['passthrough', 'resampler', 'wsola']);

/** `ChooseBufferMode`. Pitch is tested FIRST and short-circuits the copy test. */
export function chooseFillBufferMode({ requestedRate, sampleRate, preservesPitch }) {
  if (!Number.isFinite(requestedRate) || requestedRate <= 0) throw new RangeError(`mechanism-audio: requested rate must be positive and finite, got ${requestedRate}`);
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 100) throw new RangeError(`mechanism-audio: sample rate must be a whole number of samples/s, got ${sampleRate}`);
  if (typeof preservesPitch !== 'boolean') throw new TypeError('mechanism-audio: preservesPitch must be stated, not defaulted');
  if (!preservesPitch) return 'resampler';
  const windowSamples = olaWindowSamples(sampleRate);
  const slowerStep = Math.ceil(windowSamples * requestedRate);
  const fasterStep = Math.ceil(windowSamples / requestedRate);
  return windowSamples <= fasterStep && slowerStep >= windowSamples ? 'passthrough' : 'wsola';
}

/**
 * The advance the mode really produces, and the label saying how much of it is
 * ported and how much is an admitted approximation.
 *
 * `passthrough` is a PORT: `FillBuffer` assigns `effective_playback_rate_ = 1.0`
 * on that branch, and `audio_clock_->WroteAudio(..., effective_playback_rate)`
 * is what advances the media clock — so a near-unity command moves media time
 * by exactly nothing. `resampler` is a port too: the resampler consumes input at
 * the ratio it was set to.
 *
 * `wsola` is NOT a port. Its real instantaneous rate is frames-consumed over
 * frames-produced per `FillBuffer` call, which needs the search/overlap state
 * this model does not carry. `ideal-steady` says so out loud and uses the
 * requested rate; no other WSOLA model is implemented, and asking for one throws
 * rather than returning a number that looks ported.
 */
export const WSOLA_MODELS = Object.freeze(['ideal-steady']);

export function effectiveAdvanceRate({ requestedRate, sampleRate, preservesPitch, wsolaModel = 'ideal-steady' }) {
  if (!WSOLA_MODELS.includes(wsolaModel)) throw new RangeError(`mechanism-audio: unknown WSOLA model ${wsolaModel}`);
  const mode = chooseFillBufferMode({ requestedRate, sampleRate, preservesPitch });
  if (mode === 'passthrough') return { mode, effectiveRate: 1, fidelity: 'ported' };
  if (mode === 'resampler') return { mode, effectiveRate: requestedRate, fidelity: 'ported' };
  return { mode, effectiveRate: requestedRate, fidelity: `approximated:${wsolaModel}` };
}

/**
 * The audio clock and the time source built on it.
 *
 * `WroteAudio` is modelled for the steady case the sweep runs in — every render
 * request is filled, the hardware delay is constant — so the buffer is a FIFO of
 * `{frames, rate}` blocks, the back timestamp accumulates written frames at the
 * rate they were written at, and the front timestamp is the back minus the media
 * duration the buffer still holds. That is the source's own arithmetic.
 *
 * OMITTED, DELIBERATELY: underflow, capacity growth, suspended writes, the
 * `CurrentMediaTime` interpolation term and its clamp against the back
 * timestamp. The interpolation term is `(now - last_render_time) * rate`, and
 * this model services audio at every event, so `last_render_time` is always the
 * current instant and the term is identically zero. The rest need a starved or
 * seeking pipeline, which no case in the frozen matrix produces.
 *
 * `idealAdvance` is the ISOLATION CONTROL, not a browser configuration: it makes
 * the effective rate equal the requested rate whatever the mode selector says,
 * so a case run with it has the audio mechanism switched off rather than
 * switched to some other real branch. It is reported as `mode: 'ideal'`, never
 * as `resampler`, because a control must not be mistakable for a pitch claim.
 *
 * @param {{sampleRate: number, preservesPitch: boolean, startMediaMs: number,
 *   startWallMs: number, bufferFrames?: number, wsolaModel?: string,
 *   idealAdvance?: boolean}} config
 */
export function createAudioTimeSource({
  sampleRate,
  preservesPitch,
  startMediaMs,
  startWallMs,
  bufferFrames = timeToFrames(200, sampleRate),
  wsolaModel = 'ideal-steady',
  idealAdvance = false,
  primedRate = 1,
}) {
  const msPerFrame = 1000 / sampleRate;
  // `primedRate: 0` is the cold start the first `WroteAudio` produces — a buffer
  // full of delay frames holding no media duration, so the front timestamp is a
  // whole hardware delay away from being heard. The default 1 starts the model
  // MID-PLAYBACK instead, which is the state every case in the matrix is about;
  // the difference is a ~200 ms transient in the media-to-wall mapping and it is
  // swept as its own manufactured case rather than assumed away.
  let blocks = [{ frames: bufferFrames, rate: primedRate }];
  let backMs = startMediaMs + bufferFrames * primedRate * (1000 / sampleRate);
  let frontMs = startMediaMs;
  let lastRenderWallMs = startWallMs;
  let requestedRate = 1;
  const modeCounts = Object.fromEntries([...FILL_BUFFER_MODES, 'ideal'].map((mode) => [mode, 0]));

  const bufferedMediaMs = () => blocks.reduce((sum, block) => sum + block.frames * block.rate * msPerFrame, 0);

  function push(frames, rate) {
    if (frames <= 0) return;
    const last = blocks.at(-1);
    if (last && last.rate === rate) last.frames += frames;
    else blocks.push({ frames, rate });
  }

  function pop(frames) {
    let remaining = frames;
    while (remaining > 0 && blocks.length > 0) {
      const head = blocks[0];
      const taken = Math.min(head.frames, remaining);
      head.frames -= taken;
      remaining -= taken;
      if (head.frames <= 0) blocks.shift();
    }
  }

  /**
   * One audio service interval: `frames` are played out and the same number
   * written. `loadMultiplier` is the PHYSICAL media/reference rate mismatch,
   * applied after the mode has been chosen from the commanded rate — the browser
   * selects its branch on what it was asked for, and a crystal that runs fast
   * cannot change which branch that was.
   */
  function advanceWall(dtMs, nextRequestedRate, loadMultiplier = 1) {
    if (!(dtMs >= 0)) throw new RangeError(`mechanism-audio: wall advance must not go backwards, got ${dtMs}`);
    // `WroteAudio` writes exactly what it played, so the buffer holds a constant
    // number of frames. A step longer than the buffer would pop frames that were
    // never there and silently lose the transport delay this file exists to
    // carry — refuse it rather than model a starved pipeline as a healthy one.
    if (dtMs > bufferFrames * msPerFrame) throw new RangeError(`mechanism-audio: ${dtMs}ms advance exceeds the ${(bufferFrames * msPerFrame).toFixed(3)}ms buffer; this model does not represent underflow`);
    requestedRate = nextRequestedRate;
    const chosen = effectiveAdvanceRate({ requestedRate, sampleRate, preservesPitch, wsolaModel });
    const mode = idealAdvance ? 'ideal' : chosen.mode;
    const effectiveRate = (idealAdvance ? requestedRate : chosen.effectiveRate) * loadMultiplier;
    modeCounts[mode] += 1;
    const frames = dtMs / msPerFrame;
    pop(frames);
    push(frames, effectiveRate);
    backMs += frames * effectiveRate * msPerFrame;
    frontMs = Math.max(frontMs, backMs - bufferedMediaMs());
    lastRenderWallMs += dtMs;
    return { mode, effectiveRate };
  }

  /** The rate the next advance would use, without taking one. */
  function peekEffectiveRate(nextRequestedRate, loadMultiplier = 1) {
    const chosen = effectiveAdvanceRate({ requestedRate: nextRequestedRate, sampleRate, preservesPitch, wsolaModel });
    return {
      mode: idealAdvance ? 'ideal' : chosen.mode,
      effectiveRate: (idealAdvance ? nextRequestedRate : chosen.effectiveRate) * loadMultiplier,
    };
  }

  /** `AudioClock::TimeUntilPlayback` — wall time, walking the blocks in order. */
  function timeUntilPlaybackMs(mediaMs) {
    let frames = 0;
    let mediaCursor = frontMs;
    for (const block of blocks) {
      if (block.rate === 0) { frames += block.frames; continue; }
      const deltaMs = block.frames * block.rate * msPerFrame;
      if (mediaMs <= mediaCursor + deltaMs) {
        frames += block.frames * ((mediaMs - mediaCursor) / deltaMs);
        return frames * msPerFrame;
      }
      mediaCursor += deltaMs;
      frames += block.frames;
    }
    return frames * msPerFrame;
  }

  /**
   * `AudioRendererImpl::GetWallClockTimes` for one timestamp. Inside the played
   * and buffered extents the conversion is exact; outside them it is a
   * PROJECTION AT THE REQUESTED RATE, which is the asymmetry this file exists to
   * keep visible.
   */
  function wallClockTimeForMediaMs(mediaMs) {
    if (mediaMs >= frontMs && mediaMs <= backMs) {
      return { wallMs: lastRenderWallMs + timeUntilPlaybackMs(mediaMs), branch: 'exact' };
    }
    const beyondBack = mediaMs > backMs;
    const baseMediaMs = beyondBack ? backMs : frontMs;
    const timeUntilMs = beyondBack ? timeUntilPlaybackMs(backMs) : 0;
    return {
      wallMs: lastRenderWallMs + timeUntilMs + (mediaMs - baseMediaMs) / requestedRate,
      branch: beyondBack ? 'projected-past-back' : 'projected-before-front',
    };
  }

  return {
    advanceWall,
    peekEffectiveRate,
    wallClockTimeForMediaMs,
    timeUntilPlaybackMs,
    /** `CurrentMediaTime` without its interpolation term — see the note above. */
    get currentMediaMs() { return frontMs; },
    get frontMs() { return frontMs; },
    get backMs() { return backMs; },
    get bufferedMediaMs() { return bufferedMediaMs(); },
    get requestedRate() { return requestedRate; },
    get modeCounts() { return { ...modeCounts }; },
    describe() {
      return `audio(${sampleRate} samples/s, pitch ${preservesPitch ? 'preserved' : 'disabled'}, wsola ${wsolaModel})`;
    },
  };
}
