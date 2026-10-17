/**
 * Phoenix CRM — the out-of-plan allowance's one database read (owner, 2026-10-10: two doctors a day and
 * eight a week). The rule and its words are `offplan-cap-rules.ts`; the door that enforces it is the
 * `phoenix_crm_visits_offplan_cap` trigger. This reads the same rows the trigger counts: `out_of_plan`
 * visits to AM and PM customers, per seat, in a window of visit days.
 *
 * Keyset-paged on `id` and chunked by seat, so a whole district's week is never cut at 1,000 rows.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import type { OffPlanExemptions, OffPlanRow } from "@/lib/phoenix-crm/offplan-cap-rules";

const SEATS_PER_READ = 100;

type VisitRow = { id: string; seat_id: string; customer_id: string; visit_date: string };

/** Every out-of-plan doctor visit of these seats from one visit day to another, both inclusive. */
export async function loadOffPlanRows(
  seatIds: ReadonlyArray<string>,
  isTest: boolean,
  window: { from: string; to: string },
): Promise<Array<OffPlanRow & { seatId: string }>> {
  const unique = [...new Set(seatIds)];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += SEATS_PER_READ) chunks.push(unique.slice(index, index + SEATS_PER_READ));
  const reads = await Promise.all(
    chunks.map((chunk) =>
      fetchAllRowsKeyset<VisitRow>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_visits")
            .select("id, seat_id, customer_id, visit_date")
            .in("seat_id", chunk)
            .eq("is_test", isTest)
            .eq("unplanned_kind", "out_of_plan")
            .in("list_type", ["AM", "PM"])
            // A visit under a named exception is stamped by the door and is in no count (owner, 2026-10-17).
            .eq("offplan_exempt", false)
            .gte("visit_date", window.from)
            .lte("visit_date", window.to),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
    ),
  );
  return reads.flat().map((row) => ({ seatId: String(row.seat_id), customerId: String(row.customer_id), visitDate: String(row.visit_date) }));
}

const VISITS_PER_EXEMPT_READ = 100;

/**
 * Which of these visits fell under a named exception (owner, 2026-10-17), so a manager's card can say so.
 * Chunked, because a PostgREST `.in()` with hundreds of ids returns nothing. A failed read answers an empty
 * set: a line on a card is never worth the Team tab, and the card still decides.
 */
export async function loadExemptVisitIds(visitIds: ReadonlyArray<string>): Promise<Set<string>> {
  const unique = [...new Set(visitIds)];
  const exempt = new Set<string>();
  try {
    for (let index = 0; index < unique.length; index += VISITS_PER_EXEMPT_READ) {
      const { data, error } = await getSupabaseAdmin()
        .from("phoenix_crm_visits")
        .select("id")
        .in("id", unique.slice(index, index + VISITS_PER_EXEMPT_READ))
        .eq("offplan_exempt", true);
      if (error) throw error;
      for (const row of data ?? []) exempt.add(String(row.id));
    }
  } catch (error) {
    console.error("phoenix-crm: the out-of-plan exceptions could not be read for the cards", error);
    return new Set();
  }
  return exempt;
}

/**
 * The customers of one seat that a named exception covers, and what the exception is called — what the rep's
 * picker needs so the day and the week never block them. A failed read answers none: the picker then shows
 * the ordinary limit, and the database door still lets the visit through.
 */
export async function loadOffPlanExemptions(seatId: string): Promise<OffPlanExemptions> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("phoenix_crm_offplan_exempt_customers", { p_seat: seatId });
    if (error) throw error;
    const rows = (data ?? []) as Array<{ customer_id: string; label: string }>;
    return {
      customerIds: rows.map((row) => String(row.customer_id)),
      labels: [...new Set(rows.map((row) => String(row.label)))],
    };
  } catch (error) {
    console.error("phoenix-crm: the out-of-plan exceptions could not be read", error);
    return { customerIds: [], labels: [] };
  }
}
