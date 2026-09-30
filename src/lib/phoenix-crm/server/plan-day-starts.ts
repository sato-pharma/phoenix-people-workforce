/**
 * Phoenix CRM — the Start AM and Start PM a rep plans for a day (the old CRM's weekly plan carried both
 * on every day; the owner walked through it on 2026-09-29). The rules — what a day may carry, what a
 * save body is read as — are pure, in plan-day-starts.ts; this is only the reading and the writing.
 *
 * A PLAN record: no call rate reads it and no visit is judged against it.
 */

import { isMinuteOfDay, type PlanDayStarts, type PlannedDayStart } from "@/lib/phoenix-crm/plan-day-starts";
import { callPhoenixCrm, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function minuteOrNull(value: unknown): number | null {
  const minute = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return isMinuteOfDay(minute) ? minute : null;
}

/** The start times on some week plans of ONE territory, by day (a territory has one plan a week). */
export async function loadPlanDayStarts(planIds: readonly string[]): Promise<Map<string, PlanDayStarts>> {
  if (planIds.length === 0) return new Map();
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_plan_day_starts")
    .select("plan_date, start_am_minute, start_pm_minute")
    .in("plan_id", [...planIds]);
  throwIfError(error);
  const byDay = new Map<string, PlanDayStarts>();
  for (const row of (data ?? []) as Row[]) {
    const planDate = textOrNull(row.plan_date);
    if (!planDate) continue;
    byDay.set(planDate, { startAmMinute: minuteOrNull(row.start_am_minute), startPmMinute: minuteOrNull(row.start_pm_minute) });
  }
  return byDay;
}

/** Replace the start times on the editable days of one week's plan. The plan must exist. */
export async function savePlanDayStarts(input: {
  seatId: string;
  actorHrId: string;
  isTest: boolean;
  weekStart: string;
  editableDays: readonly string[];
  starts: readonly PlannedDayStart[];
}): Promise<number> {
  const result = await callPhoenixCrm<Row>("phoenix_crm_save_plan_day_starts", {
    p: {
      seat_id: input.seatId,
      actor_hr_id: input.actorHrId,
      is_test: input.isTest,
      week_start: input.weekStart,
      editable_days: input.editableDays,
      starts: input.starts.map((start) => ({
        plan_date: start.planDate,
        start_am_minute: start.startAmMinute,
        start_pm_minute: start.startPmMinute,
      })),
    },
  });
  return Number(result.start_count ?? 0);
}
