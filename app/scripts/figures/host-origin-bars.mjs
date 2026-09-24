export const FROZEN_BASELINE = Object.freeze({
  uplinkUtilisationMean: 0.9783371042887482,
  realtimeFactorByClient: Object.freeze({
    c01: 0.7158109417174922,
    c02: 0.7190442553638237,
    c03: 0.7157350815093185,
    c04: 0.7140158409653904,
    c05: 0.7165970754072845,
  }),
  originWasteFraction: 0,
  hostUploadMultiplier: 3.430246412269449,
});

export const FROZEN_BARS = Object.freeze({ B1: 0.90, B2: 0.63, B4: 0.01, B5: 0.02, B3Factor: 0.90, uncappedMedian: 0.95 });

const finite = (value) => Number.isFinite(value);
const BASELINE_TAGS = Object.keys(FROZEN_BASELINE.realtimeFactorByClient);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function figuresOf(value) {
  return value?.figures ?? value?.publishedByte ?? value ?? {};
}

function refused(value) {
  return value?.refused === true || value?.runRefused === true || value?.status === 'refused' || value?.finalization?.status === 'refused';
}

function same(left, right) {
  return Object.is(left, right);
}

function verifyBaseline(baseline) {
  const actual = figuresOf(baseline);
  const checks = [
    ['uplinkUtilisationMean', actual.uplinkUtilisationMean, FROZEN_BASELINE.uplinkUtilisationMean],
    ['originWasteFraction', actual.originWasteFraction, FROZEN_BASELINE.originWasteFraction],
    ['hostUploadMultiplier', actual.hostUploadMultiplier, FROZEN_BASELINE.hostUploadMultiplier],
  ];
  for (const [tag, expected] of Object.entries(FROZEN_BASELINE.realtimeFactorByClient)) checks.push([`realtimeFactorByClient.${tag}`, actual.realtimeFactorByClient?.[tag], expected]);
  for (const [name, actualValue, expected] of checks) if (!same(actualValue, expected)) throw new Error(`baseline differs from frozen ${name}`);
  return true;
}

function clientFactors(figure) {
  return BASELINE_TAGS.map((tag) => Number(figure?.realtimeFactorByClient?.[tag]));
}

// The figures an arm is judged on. The uncapped arm declares no capacity, so its
// byte publication is always refused and `publishedByte` holds only that
// refusal; its realtime factors are in the recomputed figures. Only that arm
// falls back: a capped arm refused publication is refused (7a d1-findings D1-3).
export function armFigures(recomputed, arm) {
  if (arm !== 'capped' && arm !== 'uncapped') throw new TypeError('armFigures: arm must be capped or uncapped');
  const published = recomputed?.publishedByte;
  if (published && published.published !== false) return published;
  return arm === 'uncapped' ? recomputed?.figures : { ...published, status: 'refused' };
}

export function judgeHostOrigin({ baseline, capped, uncapped } = {}) {
  const baselineVerified = verifyBaseline(baseline);
  const cappedFigures = figuresOf(capped);
  const uncappedFigures = figuresOf(uncapped);
  const factors = clientFactors(cappedFigures);
  const cappedComplete = factors.every(finite);
  const cappedMedian = cappedComplete ? median(factors) : undefined;
  const cappedMinimum = cappedComplete ? Math.min(...factors) : undefined;
  const peer = cappedFigures.peerByteFractionByClient ?? {};
  const agreement = cappedFigures.originVsClientBytesByClient ?? {};
  const peerValues = BASELINE_TAGS.map((tag) => Number(peer[tag]));
  const agreementValues = BASELINE_TAGS.map((tag) => Number(agreement[tag]?.differenceFraction));
  const b5Values = [...peerValues, ...agreementValues];
  const bars = {
    B1: { value: cappedFigures.uplinkUtilisationMean, bar: FROZEN_BARS.B1, pass: finite(cappedFigures.uplinkUtilisationMean) && cappedFigures.uplinkUtilisationMean >= FROZEN_BARS.B1 },
    B2: { value: cappedMedian, bar: FROZEN_BARS.B2, pass: finite(cappedMedian) && cappedMedian >= FROZEN_BARS.B2 },
    B3: { value: cappedMinimum, bar: finite(cappedMedian) ? FROZEN_BARS.B3Factor * cappedMedian : undefined, pass: finite(cappedMinimum) && finite(cappedMedian) && cappedMinimum >= FROZEN_BARS.B3Factor * cappedMedian },
    B4: { value: cappedFigures.originWasteFraction, bar: FROZEN_BARS.B4, pass: finite(cappedFigures.originWasteFraction) && cappedFigures.originWasteFraction <= FROZEN_BARS.B4 },
    B5: {
      value: { peer: peerValues, agreement: agreementValues },
      bar: FROZEN_BARS.B5,
      pass: b5Values.length > 0 && b5Values.every((value) => finite(value) && Math.abs(value) <= FROZEN_BARS.B5),
    },
  };
  const uncappedFactors = clientFactors(uncappedFigures);
  const uncappedMedian = uncappedFactors.every(finite) ? median(uncappedFactors) : undefined;
  const uncappedFast = !refused(uncapped) && finite(uncappedMedian) && uncappedMedian >= FROZEN_BARS.uncappedMedian;
  const cappedPass = !refused(capped) && Object.values(bars).every((bar) => bar.pass);
  const routing = refused(capped) || refused(uncapped)
    ? 'instrument-refusal'
    : cappedPass ? 'capped-pass'
      : uncappedFast ? 'owner-decision'
        : 'transport-ceiling';
  return { baselineVerified, bars, uncappedFast, routing };
}
