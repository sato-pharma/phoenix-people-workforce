/**
 * Phoenix CRM — WHOSE decision is waiting, and how many: ONE producer, two readers.
 *
 * These counts were private to `server/overview.ts` (the module page's own "waiting for you" badge)
 * until the central Needs You board grew a Phoenix CRM source (2026-10-03). The board must agree with
 * the module to the row — a board that says 0 while the module's own badge says 3 is the under-report
 * that `src/lib/needs-you/types.ts` exists to make impossible — so the rule moved here and BOTH read
 * it. A second copy over there would have been the exact drift the CEO command centre already paid
 * for (`src/lib/needs-you/sources.ts`, the header's "one producer per rule").
 *
 * ## The two authorities, and why the seat sets differ
 *
 *   - the MANAGER step is the territory's own reviewer (`canReviewTerritory`), so it is counted on the
 *     seats this viewer reviews;
 *   - the SFE step is the SFE Manager's across his WHOLE scope — he holds no sales seat, so he can
 *     never appear in a territory's manager chain (`canDecideUnplannedVisit`).
 *
 * The Super Admin is `null` seats, meaning every territory and every step, because his own entries are
 * test entries (owner, 2026-09-16 — `access.ts`) and `isTest` below is then true. That is the module's
 * own rule and it travels with the counts rather than being restated by either caller.
 *
 * ## Head counts, never rows
 *
 * `{ count: "exact", head: true }` is not subject to PostgREST's 1,000-row ceiling — it returns a
 * number and no rows at all — so these are the one shape in this module that is correct WITHOUT
 * paging. Anything that needs the rows themselves (the Team tab) pages (`loadRequestRows`,
 * `loadUnplannedRows`); anything that needs only the number asks here.
 */

import { plannableWeeks } from "@/lib/phoenix-crm/calendar";
import { canReviewTerritory, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { UNPLANNED_FIRST_STATUSES, type UnplannedVisitStatus } from "@/lib/phoenix-crm/unplanned-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Which world this viewer decides in, and on which seats at each step.
 *
 * `reviewSeatIds === null` means EVERY territory at EVERY step — the Super Admin, in the test world.
 * An EMPTY array means he reviews nothing, which is a true zero and is never read as "all".
 */
export type PhoenixCrmDecisionSeats = {
  /** The world the two decision counts are in: test for the Super Admin and for a test account. */
  isTest: boolean;
  reviewSeatIds: string[] | null;
  /** The SFE Manager's second step, across his whole scope. Real entries only; empty for everyone else. */
  sfeSeatIds: string[];
};

export function phoenixCrmDecisionSeats(viewer: PhoenixCrmViewer): PhoenixCrmDecisionSeats {
  const scope = viewer.scopeTerritories;
  return {
    // Real decisions are the reviewer's; the Super Admin decides test entries only, from his "Test
    // accounts" tab (owner, 2026-10-22). A test account decides none any more, so `canReviewTerritory`
    // answers false on every seat for it and its counts are a true zero.
    isTest: viewer.isSuperAdmin || viewer.isTestPersona,
    reviewSeatIds: viewer.isSuperAdmin
      ? null
      : scope.filter((seat) => canReviewTerritory(viewer, seat, viewer.isTestPersona)).map((seat) => seat.seatId),
    sfeSeatIds:
      !viewer.isSuperAdmin && !viewer.isTestPersona && viewer.isSfeManager && viewer.canApprove
        ? scope.map((seat) => seat.seatId)
        : [],
  };
}

/**
 * One head count over a status, in chunks of 100 seats.
 *
 * `fromWeek` keeps a plan count to the weeks the Team tab lists (`plannableWeeks`): a plan whose week
 * is over no longer waits for anyone. `stage` is the step a list request is ON (2026-09-29): a grade
 * change and the first step of a drop, an add or a bring-back are the territory's reviewer's; the
 * second step is the SFE Manager's.
 */
export async function countPhoenixCrmWaiting(
  table: "phoenix_crm_list_requests" | "phoenix_crm_plans",
  status: "pending" | "submitted",
  isTest: boolean,
  seatIds: string[] | null,
  fromWeek: string | null = null,
  stage: "reviewer" | "sfe" | null = null,
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const count = (seatPart: string[] | null) => {
    let query = supabase.from(table).select("id", { count: "exact", head: true }).eq("status", status).eq("is_test", isTest);
    if (seatPart) query = query.in("seat_id", seatPart);
    if (fromWeek) query = query.gte("week_start", fromWeek);
    if (stage === "reviewer") query = query.or("stage.is.null,stage.eq.manager");
    if (stage === "sfe") query = query.eq("stage", "sfe");
    return query;
  };
  if (seatIds === null) {
    const { count: total, error } = await count(null);
    throwIfError(error);
    return total ?? 0;
  }
  // The chunks are counted together, not one after another (2026-10-31, "fix the slowest five pages"): a sum
  // does not care which chunk answered first, and the first failure in chunk order is still the one raised.
  const parts = await Promise.all(chunk(seatIds, 100).map((part) => count(part)));
  let total = 0;
  for (const { count: partCount, error } of parts) {
    throwIfError(error);
    total += partCount ?? 0;
  }
  return total;
}

/**
 * Off-plan visits waiting at the given steps.
 *
 * No date filter, unlike a plan or a plan-edit count: a waiting off-plan visit does not expire with
 * its week — the visit happened, and it counts in nothing until somebody decides it, however late.
 */
export async function countPhoenixCrmUnplannedVisits(
  statuses: ReadonlyArray<UnplannedVisitStatus>,
  isTest: boolean,
  seatIds: string[] | null,
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const count = (seatPart: string[] | null) => {
    let query = supabase
      .from("phoenix_crm_unplanned_visits")
      .select("visit_id", { count: "exact", head: true })
      .in("status", [...statuses])
      .eq("is_test", isTest);
    if (seatPart) query = query.in("seat_id", seatPart);
    return query;
  };
  if (seatIds === null) {
    const { count: total, error } = await count(null);
    throwIfError(error);
    return total ?? 0;
  }
  // The chunks are counted together, not one after another (2026-10-31, "fix the slowest five pages"): a sum
  // does not care which chunk answered first, and the first failure in chunk order is still the one raised.
  const parts = await Promise.all(chunk(seatIds, 100).map((part) => count(part)));
  let total = 0;
  for (const { count: partCount, error } of parts) {
    throwIfError(error);
    total += partCount ?? 0;
  }
  return total;
}

/**
 * Weekly plans SENT and still waiting for this viewer's approval.
 *
 * 🔴 THE MANAGER STEP IS THE WHOLE RULE — there is no SFE step on a plan. The SFE Manager may RETURN
 * any week and approves none (`canReviewTerritory`), so counting his scope here would put a number on
 * his board for a decision he cannot take. `loadPlanReviews` says the same thing in the same words,
 * and the two counts must stay the same number.
 *
 * `plannableWeeks(cairoToday)[0]` is the floor: a plan whose week is over no longer waits for anyone,
 * and it is the Team tab's own window, so the count can never name a week that screen cannot open.
 *
 * It moved here on 2026-10-08 from `server/overview.ts`, where it was inlined — the module's own badge
 * counted it and the Needs You board did not, which is the under-report this file's header exists to
 * make impossible.
 */
export async function countPhoenixCrmWeeklyPlansWaitingForYou(seats: PhoenixCrmDecisionSeats, cairoToday: string): Promise<number> {
  if (reviewsNothing(seats)) return 0;
  return countPhoenixCrmWaiting("phoenix_crm_plans", "submitted", seats.isTest, seats.reviewSeatIds, plannableWeeks(cairoToday)[0]);
}

/** A viewer who reviews nothing: a true zero, and no query at all. */
function reviewsNothing(seats: PhoenixCrmDecisionSeats): boolean {
  return seats.reviewSeatIds !== null && seats.reviewSeatIds.length === 0;
}

/**
 * List requests (a grade, a drop, an add, a bring-back) waiting at a step THIS viewer takes.
 *
 * An out-of-list visit's approval is one of these: the visit validates its customer at the door and
 * files an `add` whose first step is the district manager (owner, 2026-09-26). There is no separate
 * out-of-list queue to count.
 */
export async function countPhoenixCrmListRequestsWaitingForYou(seats: PhoenixCrmDecisionSeats): Promise<number> {
  const [reviewer, sfe] = await Promise.all([
    reviewsNothing(seats)
      ? Promise.resolve(0)
      : countPhoenixCrmWaiting(
          "phoenix_crm_list_requests",
          "pending",
          seats.isTest,
          seats.reviewSeatIds,
          null,
          seats.reviewSeatIds === null ? null : "reviewer",
        ),
    seats.sfeSeatIds.length === 0
      ? Promise.resolve(0)
      : countPhoenixCrmWaiting("phoenix_crm_list_requests", "pending", false, seats.sfeSeatIds, null, "sfe"),
  ]);
  return reviewer + sfe;
}

/**
 * Off-plan visits waiting at a step THIS viewer takes — the manager's on the territories he reviews,
 * SFE's across his scope; the Super Admin's test count holds both steps.
 *
 * 🔴 IT IS THE ONE COUNT WHOSE DELAY COSTS A REP HIS FIGURES: an off-plan visit counts in NOTHING
 * until it is decided (the visit-type rule), and until 2026-10-02 three sums of the module's own
 * badge left it out entirely while the Team tab named it correctly.
 */
export async function countPhoenixCrmOffPlanVisitsWaitingForYou(seats: PhoenixCrmDecisionSeats): Promise<number> {
  const [manager, sfe] = await Promise.all([
    reviewsNothing(seats)
      ? Promise.resolve(0)
      : countPhoenixCrmUnplannedVisits(
          seats.reviewSeatIds === null ? UNPLANNED_FIRST_STATUSES : ["manager_pending"],
          seats.isTest,
          seats.reviewSeatIds,
        ),
    seats.sfeSeatIds.length === 0 ? Promise.resolve(0) : countPhoenixCrmUnplannedVisits(["sfe_pending"], false, seats.sfeSeatIds),
  ]);
  return manager + sfe;
}
