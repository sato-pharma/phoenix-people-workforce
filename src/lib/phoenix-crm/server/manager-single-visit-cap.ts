/**
 * Phoenix CRM — the district sales manager's limit of one single-visit day a week (owner, 2026-10-19).
 *
 * The rule is `dmSingleVisitCapError` (manager-plan-rules.ts): two half-days a week, any mix, counted from
 * what the week already spends on them — the single-visit half-days of his plan AND the visits he has logged
 * (a planned visit keeps its half-day; an unplanned one falls in the morning or afternoon it was logged in,
 * by Cairo time). It binds a district manager only, and the plan save and the visit log both ask it before
 * they write, so neither path can be used to get round the other.
 *
 * A read that fails throws: a limit that cannot be counted must not quietly let a third half-day through,
 * and the save or the log is the one place that can tell him to try again.
 *
 * 🔴 His two screens show the count from these same functions — the board's "This week holds N of 2"
 * (`buildBoard`, planned halves plus logged ones) and "My single visits" (`loadSingleVisitAllowance`). A
 * screen that counted only the plan said "1 of 2" while the save refused a second half-day because a visit
 * he had already logged held it (owner, 2026-10-19).
 */

import { validationError } from "@/lib/http/api-errors";
import {
  DM_SINGLE_VISIT_HALF_DAYS_MAX,
  dmSingleVisitCapError,
  managerVisitWindow,
  singleVisitHalfKey,
  singleVisitHalfOfHour,
  type ManagerHalf,
  type ManagerSlotKind,
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

/** The half an unplanned visit logged now falls in, by Cairo time. */
function halfNow(): ManagerHalf {
  return singleVisitHalfOfHour(cairoHourOf(new Date().toISOString()));
}

/** The single-visit half-days a plan's own half-days spend. */
export function plannedSingleVisitHalves(slots: ReadonlyArray<{ kind: ManagerSlotKind; date: string; half: ManagerHalf }>): Set<string> {
  const used = new Set<string>();
  for (const slot of slots) {
    if (slot.kind === "single_visit") used.add(singleVisitHalfKey(slot.date, slot.half));
  }
  return used;
}

/** The half-days of this week that already hold single visits: planned ones and ones he has logged. */
export async function loadSingleVisitHalvesUsed(input: { managerHrId: string; weekStart: string; isTest: boolean }): Promise<Set<string>> {
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
  const planned = plans.length > 0 ? plannedSingleVisitHalves(await loadManagerSlotRows(plans.map((row) => String(row.id)))) : new Set<string>();
  return new Set([...planned, ...(await loadLoggedSingleVisitHalves(input))]);
}

/** The half-days the visits he has LOGGED this week spend — a planned one keeps its half, an unplanned one its Cairo half. */
export async function loadLoggedSingleVisitHalves(input: { managerHrId: string; weekStart: string; isTest: boolean }): Promise<Set<string>> {
  const used = new Set<string>();
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

/** What "My single visits" shows him: the half-days the week holds, the most it may, and whether an unplanned visit logged now fits. */
export type SingleVisitAllowance = { used: number; max: number; unplannedFitsNow: boolean };

export async function loadSingleVisitAllowance(input: { managerHrId: string; weekStart: string; date: string; isTest: boolean }): Promise<SingleVisitAllowance> {
  const used = await loadSingleVisitHalvesUsed(input);
  return {
    used: used.size,
    max: DM_SINGLE_VISIT_HALF_DAYS_MAX,
    unplannedFitsNow: dmSingleVisitCapError(used, singleVisitHalfKey(input.date, halfNow()), "visit") === null,
  };
}

/** Refuses a single-visit half-day in a plan when the week already holds two others. */
export async function assertSingleVisitPlanFits(input: { managerHrId: string; weekStart: string; date: string; half: ManagerHalf; isTest: boolean }): Promise<void> {
  const used = await loadSingleVisitHalvesUsed(input);
  const error = dmSingleVisitCapError(used, singleVisitHalfKey(input.date, input.half), "plan");
  if (error) throw validationError(error);
}

/** Refuses an unplanned visit when it would open a third half-day of single visits in the week. */
export async function assertSingleVisitLogFits(input: { managerHrId: string; weekStart: string; date: string; isTest: boolean }): Promise<void> {
  const used = await loadSingleVisitHalvesUsed(input);
  const error = dmSingleVisitCapError(used, singleVisitHalfKey(input.date, halfNow()), "visit");
  if (error) throw validationError(error);
}
