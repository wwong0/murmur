const ENGINE_WINDOW_KEYS = Object.freeze([
  'highDemandTimeWindow',
  'httpDownloadTimeWindow',
  'p2pDownloadTimeWindow',
]);

export const ENGINE_WINDOW_DEFAULTS = Object.freeze({
  highDemandTimeWindow: 15,
  httpDownloadTimeWindow: 3000,
  p2pDownloadTimeWindow: 6000,
});

const invalid = (error) => ({ windows: null, error });

export function validateEngineWindows(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('engine-windows-must-be-an-object');
  }
  const keys = Object.keys(value);
  if (keys.length !== ENGINE_WINDOW_KEYS.length || keys.some((key) => !ENGINE_WINDOW_KEYS.includes(key))) {
    return invalid('engine-windows-keys-must-be-exact');
  }
  if (ENGINE_WINDOW_KEYS.some((key) => !Number.isFinite(value[key]) || value[key] <= 0)) {
    return invalid('engine-windows-values-must-be-finite-positive');
  }
  if (value.highDemandTimeWindow > value.httpDownloadTimeWindow
    || value.highDemandTimeWindow > value.p2pDownloadTimeWindow) {
    return invalid('engine-windows-high-demand-must-not-exceed-download');
  }
  return {
    windows: Object.freeze(Object.fromEntries(ENGINE_WINDOW_KEYS.map((key) => [key, value[key]]))),
    error: null,
  };
}
