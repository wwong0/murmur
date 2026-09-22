// Condition-specific no-P2P controls, evaluated on independently acquired bytes.

export function evaluateByteControl({ bars = {}, tags = [], figures = {} } = {}) {
  const reasons = [];
  const controls = [
    ['peerFractionAbsMax', 'peerByteFractionByClient', 'peer-byte-control', (value) => value],
    ['originClientAgreementAbsMax', 'originVsClientBytesByClient', 'origin-client-agreement', (value) => value?.differenceFraction],
  ];
  for (const [barName, field, reason, read] of controls) {
    if (bars[barName] === undefined) continue;
    const maximum = bars[barName];
    if (!Number.isFinite(maximum) || maximum < 0) throw new Error(`invalid byte control bar: ${barName}`);
    for (const tag of tags) {
      const value = read(figures[field]?.[tag]);
      if (!Number.isFinite(value)) {
        reasons.push({ reason: `${reason}-unavailable`, scope: ['byte'], tag, field });
      } else if (Math.abs(value) > maximum) {
        reasons.push({ reason: `${reason}-above-declared-bar`, scope: ['byte'], tag, value, maximum });
      }
    }
  }
  return reasons;
}
