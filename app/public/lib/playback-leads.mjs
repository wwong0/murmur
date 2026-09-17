// public/lib/playback-leads.mjs
//
// The scheduled-transition leads, sized by the fixed rule in change 5
// executor-spec.md §7 from app/results/5-leads-2026-09-15T00-12-19Z/.
// Only the entry imports these; the modules take them as arguments.

/** Delivery max plus the 250ms tick (design.md D3). */
export const TRANSITION_LEAD_MS = 300;
/** Park and first-load readiness max plus the 250ms tick (design.md D6). */
export const PREPARE_LEAD_MS = 350;
/** Fixed, not measured (design.md D3). */
export const CLOCK_ERROR_ALLOWANCE_MS = 1000;
/** The far-future bound on an operation's instant (design.md D3). */
export const MAX_FUTURE_MS = TRANSITION_LEAD_MS + CLOCK_ERROR_ALLOWANCE_MS;
/** One content frame ahead, so the frame presented is the room's (design.md D6;
 * O2 option 1′, results/5-start-diagnostic-2026-09-17T06-25-21.953Z/). */
export const PRESENTATION_ADVANCE_MS = 1000 / 24;
