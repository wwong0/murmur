// public/lib/playback-leads.mjs
//
// The scheduled-transition leads, sized by the fixed rule in change 5
// executor-spec.md §7 from app/results/5-leads-2026-09-15T00-12-19Z/.
// Only the entry imports these; the modules take them as arguments.

import { CLOSE_BUDGET_MS, ESTIMATE_WINDOW_MS, MAX_RATE_DEVIATION } from './drift-controller.mjs';

/** Delivery max plus the 250ms tick (design.md D3). */
export const TRANSITION_LEAD_MS = 300;
/** Park and first-load readiness max plus the 250ms tick (design.md D6). */
export const PREPARE_LEAD_MS = 350;
/** Fixed, not measured (design.md D3). */
export const CLOCK_ERROR_ALLOWANCE_MS = 1000;
/** The far-future bound on an operation's instant (design.md D3). */
export const MAX_FUTURE_MS = TRANSITION_LEAD_MS + CLOCK_ERROR_ALLOWANCE_MS;
/** One content frame of park advance. AN OWNER-CHOSEN CANDIDATE, not a measured
 * size — no treated gate judged it (design.md D6, O2 option 1′). */
export const PRESENTATION_ADVANCE_MS = 1000 / 24;
/** The most lateness the controller can close inside its own close budget; a
 * start later than this re-parks (7b2 design.md D3). 600 ms. */
export const LATE_START_REPARK_MS = CLOSE_BUDGET_MS * MAX_RATE_DEVIATION;
/** Re-parks one scheduled start may take before it plays late (7b2 design.md D3). */
export const MAX_LATE_REPARKS = 2;
/** 10a design.md D2: held media margin for a scheduled start. */
export const START_COVER_MARGIN_MS = 3000;
/** 10a design.md D2: initial shared-time projection for a scheduled start. */
export const START_PROJECTION_MS = 3000;
/** 10a design.md D2: maximum re-projection after missed coverage. */
export const START_PROJECTION_MAX_MS = 30000;
/** 10a design.md D4: a far skip names its difference for two estimate windows. */
export const SKIP_DWELL_MS = 2 * ESTIMATE_WINDOW_MS;
/** 10a design.md D4: a repeated far skip waits out the close budget. */
export const SKIP_REPEAT_INTERVAL_MS = CLOSE_BUDGET_MS;
