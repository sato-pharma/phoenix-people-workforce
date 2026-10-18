/**
 * Phoenix CRM — the district sales manager's limit of two single-visit days a week (owner, 2026-10-17).
 *
 * The rule is `dmSingleVisitCapError` (manager-plan-rules.ts): four half-days a week, any mix, counted from
 * what the week already spends on them — the single-visit half-days of his plan AND the visits he has logged
 * (a planned visit keeps its half-day; an unplanned one falls in the morning or afternoon it was logged in,
 * by Cairo time). It binds a district manager only, and the plan save and the visit log both ask it before
 * they write, so neither path can be used to get round the other.
 *
 * A read that fails throws: a limit that cannot be counted must not quietly let a fifth half-day through,
 * and the save or the log is the one place that can tell him to try again.
 */

import { validationError } from "@/lib/http/api-errors";
import {
  dmSingleVisitCapError,
  managerVisitWindow,
  singleVisitHalfKey,
  singleVisitHalfOfHour,
  type ManagerHalf,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { loadManagerSlotRows } from "@/lib/phoenix-crm/server/manager-plan-rows";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** The hour (0–23) an instant fell in, in Cairo. */
function cairoHourOf(iso: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Africa/Cairo" }).format(new Date(iso));
  return Number(hour);
}

/** The half-days of this week that already hold single visits: planned ones and ones he has logged. */
export async function loadSingleVisitHalvesUsed(input: { managerHrId: string; weekStart: string; isTest: boolean }): Promise<Set<string>> {
  const used = new Set<string>();

  const plans = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_plans")
        .select("id")
        .eq("manager_hr_id", input.managerHrId)
        .eq("week_start", input.weekStart)
        .eq("is_test", input.isTest),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  if (plans.length > 0) {
    for (const slot of await loadManagerSlotRows(plans.map((row) => String(row.id)))) {
      if (slot.kind === "single_visit") used.add(singleVisitHalfKey(slot.date, slot.half));
    }
  }

  // Saturday through Friday: a Friday visit belongs to this week (`managerVisitWindow`, shared with the report).
  const visitDays = managerVisitWindow(input.weekStart);
  const visits = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_visits")
        .select("id, visit_date, half, created_at")
        .eq("manager_hr_id", input.managerHrId)
        .eq("is_test", input.isTest)
        .gte("visit_date", visitDays.from)
        .lte("visit_date", visitDays.to),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  for (const visit of visits) {
    const date = String(visit.visit_date ?? "");
    if (!date) continue;
    const half: ManagerHalf | null =
      visit.half === "AM" || visit.half === "PM"
        ? visit.half
        : typeof visit.created_at === "string"
          ? singleVisitHalfOfHour(cairoHourOf(visit.created_at))
          : null;
    if (half) used.add(singleVisitHalfKey(date, half));
  }
  return used;
}

/** Refuses a single-visit half-day in a plan when the week already holds four others. */
export async function assertSingleVisitPlanFits(input: { managerHrId: string; weekStart: string; date: string; half: ManagerHalf; isTest: boolean }): Promise<void> {
  const used = await loadSingleVisitHalvesUsed(input);
  const error = dmSingleVisitCapError(used, singleVisitHalfKey(input.date, input.half), "plan");
  if (error) throw validationError(error);
}

/** Refuses an unplanned visit when it would open a fifth half-day of single visits in the week. */
export async function assertSingleVisitLogFits(input: { managerHrId: string; weekStart: string; date: string; isTest: boolean }): Promise<void> {
  const used = await loadSingleVisitHalvesUsed(input);
  const half = singleVisitHalfOfHour(cairoHourOf(new Date().toISOString()));
  const error = dmSingleVisitCapError(used, singleVisitHalfKey(input.date, half), "visit");
  if (error) throw validationError(error);
}
