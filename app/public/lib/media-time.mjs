// A media position as the page shows it. `m:ss` below an hour is the bar's long-standing
// format, so the bar's text must stay byte-equal there.
export function formatMediaTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const seconds = Math.floor(ms / 1000);
  const pad = (value) => String(value).padStart(2, '0');
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}
