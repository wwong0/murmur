const CHOOSING = 'The host is choosing a video';
const PREPARING = 'The host is preparing the video';
const ABSENT = 'The host has left';
const ABSENT_NOTE = "The room is paused until they're back";

// What the viewer's card says for the host's status, or null where there is nothing to wait for
// (design.md D16). These are not `#host-preparing`'s texts: that line keeps its lowercase words
// because N1 reads them verbatim. `percent` is null until the host has reported a fraction, and
// the title then carries no figure rather than a made-up one.
export function viewerWaitCard({ state, fraction } = {}) {
  if (state === 'choosing') return { state, title: CHOOSING, note: null, percent: null };
  if (state === 'absent') return { state, title: ABSENT, note: ABSENT_NOTE, percent: null };
  if (state !== 'preparing') return null;
  const percent = Number.isFinite(fraction) ? Math.max(0, Math.min(100, Math.floor(fraction * 100))) : null;
  return { state, title: percent === null ? PREPARING : `${PREPARING} · ${percent}%`, note: null, percent };
}

// The replicated playing state selects the visible layer (design.md D1, D2).
export function viewerLayer(input) {
  const { hostStatus, hostSide, ended, connection, playing, graceLeftS } = input ?? {};
  const status = hostStatus && typeof hostStatus === 'object' ? hostStatus : {};
  if (hostSide || ended) return { card: null, pill: null };
  if (status.state !== 'absent' || playing !== true) return { card: viewerWaitCard(status), pill: null };
  // Reconnecting, the "Reconnecting…" pill holds the place (design.md D1).
  if (connection === 'reconnecting') return { card: null, pill: null };
  const seconds = Number.isFinite(graceLeftS) ? Math.max(0, Math.ceil(graceLeftS)) : null;
  const timing = seconds === null ? 'soon' : seconds === 0 ? 'now' : `in ${seconds} s`;
  return { card: null, pill: `${ABSENT} · pausing ${timing}` };
}

export function graceSecondsLeft(endsAtSharedMs, nowSharedMs) {
  if (!Number.isFinite(endsAtSharedMs) || !Number.isFinite(nowSharedMs)) return null;
  return Math.max(0, Math.ceil((endsAtSharedMs - nowSharedMs) / 1000));
}
