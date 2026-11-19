/**
 * Phoenix CRM — reads each customer's visit tally (the last visit, the visits this month, the visits in total)
 * for the territories a weekly-plan screen shows. What the figures mean: `visit-tally.ts`.
 *
 * ONE request: `phoenix_crm_customer_visit_tally` (20261119152938) counts in SQL and answers one row per
 * customer, never every visit paged to the app. Paged by `.range()` on (seat, customer) all the same, so a read
 * across many territories can never stop at a row ceiling.
 *
 * 🔴 FAIL-SOFT: a failed read is logged and answers `read: false`, and every screen then draws nothing about
 * visits. The tally is a line beside a plan the reader came to see or sign; a database that briefly did not
 * answer must never take the plan down with it, and must never print "No visit recorded yet" about a doctor
 * who was visited.
 */

import { monthStartOf } from "@/lib/phoenix-crm/calendar";
import { emptyVisitTallies, foldVisitTallies, type VisitTallies } from "@/lib/phoenix-crm/visit-tally";
import { logError } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The tallies of every customer the given territories have visited, through `today` (Cairo). */
export async function loadVisitTallies(seatIds: ReadonlyArray<string | null | undefined>, isTest: boolean, today: string): Promise<VisitTallies> {
  const seats = [...new Set(seatIds.filter((seatId): seatId is string => typeof seatId === "string" && seatId.length > 0))];
  if (seats.length === 0) return emptyVisitTallies(true);
  try {
    const rows = await fetchAllRows<Record<string, unknown>>(
      () =>
        getSupabaseAdmin()
          .rpc("phoenix_crm_customer_visit_tally", { p_seat_ids: seats, p_is_test: isTest, p_month_start: monthStartOf(today), p_through: today })
          .order("seat_id", { ascending: true }),
      "customer_id",
    );
    return foldVisitTallies(rows);
  } catch (error) {
    logError("Phoenix CRM visit tally could not be read", {
      error,
      labels: { event: "phoenix_crm_visit_tally_failed", seats: String(seats.length) },
    });
    return emptyVisitTallies(false);
  }
}
