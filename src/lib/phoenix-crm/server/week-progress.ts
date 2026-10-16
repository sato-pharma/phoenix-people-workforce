/**
 * Phoenix CRM — his own week, planned against done: the reads.
 *
 * The rules are `src/lib/phoenix-crm/week-progress.ts` (owner, 2026-10-02). This reads the field week
 * holding the visit day: the week's own plan row and the stops on every day of it he has SENT; and the
 * week's countable visits so far. It joins `loadPhoenixCrmToday`'s one parallel wave, so the rep's day
 * waits for nothing extra (tests/portal-rep-navigation-speed.test.ts).
 *
 * 🔴 PER DAY, THROUGH `planDayStatus` — never `isPlanSentForReview` on the WEEK, which is what this
 * asked until 2026-10-02. A week returned for ONE day reads `returned`, so that one test took the
 * planned figures off the whole line: every stop he sent and nobody took back stopped being planned
 * because one day came back to him, and his own "AM 10 planned · 6 visited" dropped to "AM 6 visited"
 * overnight. The facts the day rule needs beyond the plan row are loaded by
 * `server/plan-day-status.ts`, the same reader the Planned-visit list and Today go through, and only
 * for a week returned for one day — every other plan costs nothing more than the row.
 *
 * 🔴 `phoenix_crm_countable_visits`, NEVER the raw visit table — the view every figure in the module
 * reads, so an off-plan visit waiting for approval counts here exactly when it counts everywhere else.
 * It does not ask for `customer_validated`, for the reason `loadMonthVisitCounts` gives: this is the
 * rep's own reading of his own week, set beside a plan that holds his not-yet-validated customers too,
 * and while most of a new list is still carried over from iReports360 that filter would print "0
 * visited" under a day full of green ticks.
 */

import { fieldWeekDays, fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPlanDayFacts, PLAN_DAY_COLUMNS } from "@/lib/phoenix-crm/server/plan-day-status";
import { isPlanDaySent } from "@/lib/phoenix-crm/plan-rules";
import { weekProgressOf, type WeekProgress } from "@/lib/phoenix-crm/week-progress";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** `planRow`: the same week's plan row already being read — Today reads it once for all its readers. */
export async function loadWeekProgress(
  seatId: string,
  isTest: boolean,
  visitDay: string,
  options: { planRow?: Promise<Row | null> } = {},
): Promise<WeekProgress> {
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

  let planRow: Row | null;
  if (options.planRow) {
    planRow = await options.planRow;
  } else {
    const { data: plan, error } = await supabase
      .from("phoenix_crm_plans")
      .select(`id, ${PLAN_DAY_COLUMNS}`)
      .eq("seat_id", seatId)
      .eq("is_test", isTest)
      .eq("week_start", weekStart)
      .maybeSingle();
    throwIfError(error);
    planRow = (plan as Row | null) ?? null;
  }
  let plannedListTypes: Array<string | null> = [];
  let anyDaySent = false;
  if (planRow) {
    const facts = (await loadPlanDayFacts([planRow], isTest)).get(String(planRow.id)) ?? null;
    // The week's own days, asked one at a time: a week returned for ONE day is still sent on the
    // others, and a day he can change is never counted as planned.
    const sentDays = new Set(facts ? fieldWeekDays(weekStart).filter((date) => isPlanDaySent({ ...facts, date })) : []);
    anyDaySent = sentDays.size > 0;
    if (anyDaySent) {
      const items = await supabase.from("phoenix_crm_plan_items").select("plan_date, list_type").eq("plan_id", String(planRow.id));
      throwIfError(items.error);
      plannedListTypes = ((items.data ?? []) as Row[])
        .filter((row) => sentDays.has(String(row.plan_date ?? "")))
        .map((row) => (row.list_type === null || row.list_type === undefined ? null : String(row.list_type)));
    }
  }

  const visits = await visitsRead;
  return weekProgressOf({
    weekStart,
    anyDaySent,
    plannedListTypes,
    visits: visits.map((row) => ({
      visitDate: String(row.visit_date ?? ""),
      listType: row.list_type === null || row.list_type === undefined ? null : String(row.list_type),
      pharmacyName: row.pharmacy_name === null || row.pharmacy_name === undefined ? null : String(row.pharmacy_name),
    })),
  });
}
