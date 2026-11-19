/**
 * Phoenix CRM — how often a territory's list readiness is measured (performance audit, 19 Nov 2026).
 *
 * `phoenix_crm_seat_readiness` was the database's heaviest Phoenix CRM statement: 22,228 calls since
 * 1 Nov at 121 ms and 6,048 disk blocks each, 2,699 s in all. One territory costs 2,737 blocks; the
 * whole company (111 territories) costs 55,977 blocks and 628 ms. Three callers made almost all of it:
 *
 *   • every weekly-plan SAVE stamped the territory (12,381 saves, one call each, after the answer);
 *   • every week and month planner OPEN measured it, and no planner screen ever drew the figure;
 *   • the display boards — the Team tab, the Needs you board, the exceptions screen and the adoption
 *     report — each measured every territory beneath the viewer on every open.
 *
 * This file holds the two levers, and no database client of its own, so it loads under the plain-Node
 * test runner (tests/phoenix-crm-readiness-reuse.test.ts):
 *
 * 1. THE SAVE STAMP RUNS AT MOST ONCE PER TERRITORY IN FIVE MINUTES (`readinessStamps`). The stamp
 *    writes the day a list was first complete and changes nothing else: the Team tab reads a territory
 *    as ready when it is stamped OR complete right now, so a stamp taken at the next save instead of
 *    this one changes nothing anyone sees. A failed stamp is never remembered, so the next save tries
 *    again; a rep drafting a week no longer pays one measurement per save.
 *
 * 2. THE DISPLAY BOARDS SHARE A COPY UP TO A MINUTE OLD, KEYED BY THE EXACT TERRITORY SET
 *    (`READINESS_SHARED_COPY`, the owner's minute-old freshness for a board, 2026-10-16). Only a
 *    display reader opts in; the 06:55 exceptions digest is a notification and measures live. A copy
 *    holds only the territories its caller asked for, after that caller's own scope ran, so it can never
 *    show anyone a territory outside his tree. A failed read throws and is never kept.
 *
 * 🔴 A WRITE THAT CHANGES WHAT A LIST COUNTS DROPS THE SHARED COPY BEFORE IT ANSWERS. Readiness counts a
 * reference customer validated (status active), dropped, waiting on a drop request, or open; every app
 * write that can move one of those goes through `callPhoenixCrm`, which calls
 * `dropSharedReadinessAfter` with the function's name. A writer missing from `READINESS_WRITERS`
 * leaves a board at most a minute behind — never wrong for longer.
 */

import { bumpSharedReadGeneration, type SharedReadLimits } from "@/lib/cache/shared-read";
import { createRecentOnce } from "@/lib/phoenix-crm/server/recent-once";

/** The shared-copy namespace the display boards read readiness through. */
export const READINESS_SHARED_COPY = "phoenix-crm:readiness";

/** One row per territory; a company read is 111 rows, so this holds every board's set many times over. */
export const READINESS_SHARED_LIMITS: SharedReadLimits = { maxEntries: 200, maxRowsTotal: 20_000 };

/**
 * The app writes that change a reference customer's readiness state: validation (and its review,
 * restore and sharing across lines), the list requests (a drop waits as `drop_pending`), a customer
 * moved between seats, a list loaded from a sheet, and an `outside` archive.
 */
export const READINESS_WRITERS: ReadonlySet<string> = new Set([
  "phoenix_crm_add_place",
  "phoenix_crm_archive_outside",
  "phoenix_crm_create_request",
  "phoenix_crm_decide_manager_customer_removal",
  "phoenix_crm_decide_request",
  "phoenix_crm_decide_validation_review",
  "phoenix_crm_load_list_customers",
  "phoenix_crm_move_customer",
  "phoenix_crm_restore_validation",
  "phoenix_crm_return_request",
  "phoenix_crm_reverse_list_request",
  "phoenix_crm_share_line_validation",
  "phoenix_crm_validate_customer",
  "phoenix_crm_withdraw_request",
]);

/** Called by `callPhoenixCrm` after every successful write: a readiness writer drops the shared copy. */
export function dropSharedReadinessAfter(fn: string): void {
  if (READINESS_WRITERS.has(fn)) bumpSharedReadGeneration(READINESS_SHARED_COPY, fn);
}

/** How long a territory's save stamp is not repeated. */
export const READINESS_STAMP_FRESH_MS = 5 * 60_000;

/** Far above the company's territories, so the oldest stamp going first only ever means one extra run. */
const READINESS_STAMPS_MAX = 2_000;

/** The save stamp's throttle, one key per territory. */
export const readinessStamps = createRecentOnce({ freshMs: READINESS_STAMP_FRESH_MS, maxKeys: READINESS_STAMPS_MAX });
