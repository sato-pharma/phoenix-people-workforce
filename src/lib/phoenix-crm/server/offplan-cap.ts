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
import type { OffPlanRow } from "@/lib/phoenix-crm/offplan-cap-rules";

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
            .gte("visit_date", window.from)
            .lte("visit_date", window.to),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
    ),
  );
  return reads.flat().map((row) => ({ seatId: String(row.seat_id), customerId: String(row.customer_id), visitDate: String(row.visit_date) }));
}
