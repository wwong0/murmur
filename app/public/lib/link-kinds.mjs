export const LINKS_LINE_RE = /^host links: \d+ direct · \d+ relayed · \d+ pending$/;

export function linkKind(statsReport) {
  if (!statsReport) return 'pending';
  return statsReport.relayed === true ? 'relayed' : 'direct';
}

export function linksText({ direct = 0, relayed = 0, pending = 0 } = {}) {
  return `host links: ${direct} direct · ${relayed} relayed · ${pending} pending`;
}
