const CHOOSING = 'The host is choosing a video';
const PREPARING = 'The host is preparing the video';
const ABSENT = 'The host has left';
const ABSENT_NOTE = "The room pauses until they're back";

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
