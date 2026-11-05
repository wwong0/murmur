// The trap is using a harness timestamp or currentTime as evidence; this keeps
// instants in the page clock and uses currentTime only for the buffer check.
const MARKER = '__HARNESS_DRIFT_DISTURBANCE__';

export function disturbanceExpression(declared = {}) {
  const pauseMs = Number(declared.pauseMs);
  return `/* ${MARKER} */ (async () => {
    const pageNow = () => performance.timeOrigin + performance.now();
    const snapshot = () => {
      const playback = __app.playback();
      return { opens: playback?.opens, begun: playback?.begun, retargets: playback?.retargets,
        skips: playback?.skips };
    };
    const callbacksBefore = __app.playback()?.callbacks;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const video = document.querySelector('video');
    const before = snapshot();
    const clock = __app.clock();
    const playback = __app.playback();
    const controller = __app.controller();
    const pitch = __app.pitch();
    let bufferedAheadMs = NaN;
    if (video) {
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (video.currentTime >= video.buffered.start(index) && video.currentTime <= video.buffered.end(index)) {
          bufferedAheadMs = Math.max(0, (video.buffered.end(index) - video.currentTime) * 1000);
          break;
        }
      }
    }
    const callbacksAfter = playback?.callbacks;
    const preconditions = {
      clockOffsetFinite: Number.isFinite(clock?.offsetMs),
      playbackPlaying: playback?.playing === true,
      playbackRateUnity: video?.playbackRate === 1,
      thresholdUsable: controller?.thresholdUsable === true,
      pitchActive: pitch?.controllerActive === true && pitch?.fault === null,
      bufferedAheadMs,
      bufferedAhead: Number.isFinite(bufferedAheadMs) && bufferedAheadMs >= 2000,
      callbacksIncreased: Number.isFinite(callbacksBefore) && Number.isFinite(callbacksAfter) && callbacksAfter > callbacksBefore,
    };
    const ready = [preconditions.clockOffsetFinite, preconditions.playbackPlaying,
      preconditions.playbackRateUnity, preconditions.thresholdUsable,
      preconditions.pitchActive, preconditions.bufferedAhead,
      preconditions.callbacksIncreased].every(Boolean);
    let pausedBefore = video?.paused ?? null;
    let pauseCallLocalMs = null;
    let playCallLocalMs = null;
    let playResolvedLocalMs = null;
    let playError = null;
    let injected = false;
    if (ready) {
      try {
        video.pause();
        pauseCallLocalMs = pageNow();
        await new Promise((resolve) => setTimeout(resolve, ${JSON.stringify(pauseMs)}));
        playCallLocalMs = pageNow();
        await video.play();
        playResolvedLocalMs = pageNow();
        injected = true;
      } catch (error) {
        playError = error?.name ?? error?.message ?? String(error);
      }
    }
    return {
      preconditions,
      pausedBefore,
      pauseCallLocalMs,
      playCallLocalMs,
      playResolvedLocalMs,
      playError,
      playbackBefore: before,
      playbackAfter: snapshot(),
      injected,
    };
  })()`;
}

export async function injectDisturbance(sessions, declared) {
  const injectionHarnessMs = Date.now();
  const expression = disturbanceExpression(declared);
  const results = Object.fromEntries(await Promise.all((declared.clients ?? []).map(async (tag) => {
    const session = sessions.find((candidate) => candidate.tag === tag);
    try {
      const result = await session.tab.evaluate(expression);
      return [tag, { ...result, observationMs: declared.observationMs }];
    } catch (error) {
      return [tag, { error: error?.message ?? String(error), observationMs: declared.observationMs }];
    }
  })));
  return { injectionHarnessMs, results };
}

export async function maybeInjectDisturbance(sessions, declared) {
  return declared ? injectDisturbance(sessions, declared) : null;
}

export { MARKER as DISTURBANCE_MARKER };
