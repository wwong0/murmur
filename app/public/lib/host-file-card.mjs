import { CHOOSABLE_STATES } from './host-file-source.mjs';

const CHOOSE_TITLE = 'Choose a video to watch';
const CHOOSE_ANOTHER = 'Choose another file';

// What the host's file card says for a source state. `enabled` is the source's own guard on a
// pick, so a control that follows it never offers a choice the source would ignore
// (design.md D15). A state the card does not know reads as `starting` for the same reason.
export function fileCard(state) {
  const enabled = CHOOSABLE_STATES.includes(state);
  if (state === 'awaiting-file') return { title: CHOOSE_TITLE, button: 'Choose file', enabled };
  if (state === 'preparing') return { title: 'Preparing', button: null, enabled };
  if (state === 'refused') return { title: "This file can't be played in the browser", button: CHOOSE_ANOTHER, enabled };
  if (state === 'failed') return { title: 'This file could not be prepared', button: CHOOSE_ANOTHER, enabled };
  return { title: CHOOSE_TITLE, button: 'Getting ready…', enabled };
}
