export const APP_KEYS = [
  'buildId', 'room', 'tabId', 'control', 'clock', 'positionOffset', 'hostStats',
  'harnessSeekError', 'engineWindows', 'headroom', 'hostPace', 'drift', 'summary',
  'controller', 'ticks', 'placement', 'startTiming', 'pitch', 'treatmentEvidence', 'delivery', 'hostLink',
  'urgentContext', 'hostAsks', 'hostCounters', 'hostReceipts', 'peerExchange',
  'urgentDelay', 'peerEngineConfig', 'peerBytes', 'heldAhead', 'resumes', 'playback',
  'playbackState', 'timeline', 'hostFile', 'title', 'hostGrace',
];

export function appKeysEqual(actual) {
  return Array.isArray(actual)
    && actual.length === APP_KEYS.length
    && new Set(actual).size === actual.length
    && APP_KEYS.every((key) => actual.includes(key));
}
