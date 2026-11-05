export const BATCHES = {
  '13d': {
    ledger: 'RUNS-13d.json',
    verdicts: 'core-tests/verdicts.json',
    readings: '13d-readings-2026-10-26T22-20-47Z/readings.json',
    classes: '13d-session-2026-10-26/classes.json',
  },
  '13e': {
    ledger: 'RUNS-13e.json',
    verdicts: 'comparison-and-stress-tests/verdicts.json',
    readings: '13e-session-2026-10-27/readings/readings.json',
    classes: '13e-session-2026-10-27/classes.json',
  },
  '13f': {
    ledger: 'RUNS-13f.json',
    verdicts: '13f-session-2026-10-28/review-d1/verdicts/verdicts.json',
    readings: '13f-session-2026-10-28/readings/readings.json',
    classes: null,
  },
};
export const CLASSES_13F = { '13f-r0-five': 'healthy', '13f-w-long': 'healthy' };
export const W13F = '13f-w-long-2026-10-28T13-23-36.241Z';
export const SHARING = { without: ['13d-b-nop2p-20', '13e-b2-nop2p-20'], with: ['13d-b-product-20'] };
export const NO_SHARING_10 = ['13d-b-nop2p-10', '13e-b2-nop2p-10'];
export const WITH_SHARING_10 = '13d-a-five';
export const ROOM_SIZES = ['13d-a2-two', '13d-a2-three', '13d-a-five', '13d-a-ten'];
export const SYNC = [
  { condition: '13d-a-five', oneRefresh: true },
  { condition: '13d-l-loss5', oneRefresh: true },
  { condition: '13d-d-delay25', oneRefresh: true },
  { condition: '13e-t-skew60', oneRefresh: false },
];
export const WAITS = { landings: '13d-e-product', join: '13d-j-join', landings10: '13e-e10-product' };
export const OFF_THE_SHELF = '13e-nd-defaults';
export const RECOVERY = { current: '13e-q-product', earlier: '13e-q-control' };
export const WEAKER = ['13e-u-host5', '13e-u-one1'];
export const WEAKER_NOTES_ONLY = '13e-u-viewers3';
export const HOUR = W13F;
export const labelOf = (entry) => {
  return entry?.scored === false ? 'diagnostic' : 'pre-registered';
};
export function normaliseVerdicts(verdicts, reportsByDirectory) {
  if (Array.isArray(verdicts.entries)) {
    return verdicts;
  }
  return {
    ...verdicts,
    entries: verdicts.runs.map(({ directory, condition, valid, reasons, playbackRefused }) => ({
      directory,
      condition,
      valid,
      reasons,
      playbackRefused,
      figures: reportsByDirectory[directory]?.figures ?? null,
    })),
  };
}
