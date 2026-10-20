const CHOOSE_TITLE = 'Choose a video to watch';
const CHOOSE_ANOTHER = 'Choose another file';
const CHOOSE_NOTE = 'MP4 from your computer. It stays on your device.';
const PREPARING_NOTE = 'Your friends will see the video when this finishes.';
const FAILED_NOTE = 'Choose it again, or pick another file. The details are in Stats.';

// What the host's file card shows for a source state (design.md D15): `kind` is `status` for a
// card that reports and `choosing` for one that asks, `icon` is `warn`, `video` or null, and
// `percent` is null except while preparing. Whether the button takes a press is the view's
// `choosable`, not the card's. A state the card does not know reads as `starting`.
export function fileCard(state, fraction) {
  if (state === 'preparing') {
    const percent = Math.min(100, Math.floor((fraction ?? 0) * 100));
    return { kind: 'status', icon: null, title: `Preparing · ${percent}%`, percent, note: PREPARING_NOTE, button: null };
  }
  if (state === 'refused') return { kind: 'status', icon: 'warn', title: "This file can't be played in the browser", percent: null, note: null, button: CHOOSE_ANOTHER };
  if (state === 'failed') return { kind: 'status', icon: 'warn', title: 'This file could not be prepared', percent: null, note: FAILED_NOTE, button: CHOOSE_ANOTHER };
  const button = state === 'awaiting-file' ? 'Choose file' : 'Getting ready…';
  return { kind: 'choosing', icon: 'video', title: CHOOSE_TITLE, percent: null, note: CHOOSE_NOTE, button };
}
