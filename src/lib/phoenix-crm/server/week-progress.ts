/**
 * Phoenix CRM — his own week, planned against done: the reads.
 *
 * The rules are `src/lib/phoenix-crm/week-progress.ts` (owner, 2026-10-02). This reads the field week
 * holding the visit day: the week's own plan row and, when it is sent, its stops' list types; and the
 * week's countable visits so far. It joins `loadPhoenixCrmToday`'s one parallel wave, so the rep's day
 * waits for nothing extra (tests/portal-rep-navigation-speed.test.ts).
 *
 * 🔴 `phoenix_crm_countable_visits`, NEVER the raw visit table — the view every figure in the module
 * reads, so an off-plan visit waiting for approval counts here exactly when it counts everywhere else.
 * It does not ask for `customer_validated`, for the reason `loadMonthVisitCounts` gives: this is the
 * rep's own reading of his own week, set beside a plan that holds his not-yet-validated customers too,
 * and while most of a new list is still carried over from iReports360 that filter would print "0
 * visited" under a day full of green ticks.
 */

import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import type { PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";
import { isPlanSentForReview } from "@/lib/phoenix-crm/plan-rules";
import { weekProgressOf, type WeekProgress } from "@/lib/phoenix-crm/week-progress";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export async function loadWeekProgress(seatId: string, isTest: boolean, visitDay: string): Promise<WeekProgress> {
  const weekStart = fieldWeekStart(visitDay);
  const supabase = getSupabaseAdmin();
  // Started beside the plan's own read, never after it: neither needs the other.
  const visitsRead = fetchAllRowsKeyset<Row>(
    () =>
      supabase
        .from("phoenix_crm_countable_visits")
        .select("id, visit_date, list_type, pharmacy_name")
        .eq("seat_id", seatId)
        .eq("is_test", isTest)
        .gte("visit_date", weekStart)
        .lte("visit_date", visitDay),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  // Handled the moment it starts: a failure of the plan's read landing first must never leave this
  // one as an unhandled rejection. Its own failure still surfaces through the await below.
  visitsRead.catch(() => undefined);

  const { data: plan, error } = await supabase
    .from("phoenix_crm_plans")
    .select("id, status")
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .eq("week_start", weekStart)
    .maybeSingle();
  throwIfError(error);
  const planStatus = plan ? (String((plan as Row).status ?? "") as PhoenixCrmPlanStatus) : null;
  let plannedListTypes: Array<string | null> = [];
  if (plan && isPlanSentForReview(planStatus)) {
    const items = await supabase.from("phoenix_crm_plan_items").select("list_type").eq("plan_id", String((plan as Row).id));
    throwIfError(items.error);
    plannedListTypes = ((items.data ?? []) as Row[]).map((row) => (row.list_type === null || row.list_type === undefined ? null : String(row.list_type)));
  }

  const visits = await visitsRead;
  return weekProgressOf({
    weekStart,
    planStatus,
    plannedListTypes,
    visits: visits.map((row) => ({
      visitDate: String(row.visit_date ?? ""),
      listType: row.list_type === null || row.list_type === undefined ? null : String(row.list_type),
      pharmacyName: row.pharmacy_name === null || row.pharmacy_name === undefined ? null : String(row.pharmacy_name),
    })),
  });
}
