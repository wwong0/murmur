export const DEFAULT_TARGET_SEGMENT_SECONDS = 4;
export const REMUX_FORMAT_VERSION = 1;

export function targetMillis(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0.001 || seconds > 3600) {
    throw new RangeError(`invalid target seconds: ${seconds}`);
  }
  const millis = Math.round(seconds * 1000);
  if (Math.abs(seconds * 1000 - millis) > 1e-9) {
    throw new RangeError(`target seconds is not an exact millisecond value: ${seconds}`);
  }
  return millis;
}
