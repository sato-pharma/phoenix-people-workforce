/**
 * Phoenix CRM — the other activities a rep PLANS for a day: a meeting, a conference, a health day, a
 * sales day, training, admin work, travel (owner, 2026-09-29 — "other activities at the top of the
 * day"). They sit on the week's plan, one a day, above the day's customers.
 *
 * A PLAN, not a record: what the day actually was is still the day activity he records on the day
 * (day-activities.ts), and — the 2026-09-26 ruling — neither moves a call rate, a coverage figure or a
 * plan-against-actual. Leave is not here either: HR's vacation module stays the only leave record.
 */

import { dayActivityLabel, isDayActivity, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import { callPhoenixCrm, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** Longest note a planned activity keeps (the table refuses more). */
export const PLAN_ACTIVITY_NOTE_MAX = 300;

export type PlannedActivityRow = {
  planDate: string;
  activityType: PhoenixCrmDayActivity;
  activityLabel: string;
  halfDay: boolean;
  note: string | null;
};

export type PlannedActivityDraft = { planDate: string; activityType: PhoenixCrmDayActivity; halfDay: boolean; note: string | null };

function mapRow(row: Row): PlannedActivityRow | null {
  const planDate = textOrNull(row.plan_date);
  const activityType = row.activity_type;
  if (!planDate || !isDayActivity(activityType)) return null;
  return {
    planDate,
    activityType,
    activityLabel: dayActivityLabel(activityType),
    halfDay: row.half_day === true,
    note: textOrNull(row.note),
  };
}

/** Every planned activity on some week plans of ONE territory, by day (a territory has one plan a week). */
export async function loadPlanActivities(planIds: readonly string[]): Promise<Map<string, PlannedActivityRow>> {
  if (planIds.length === 0) return new Map();
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_plan_activities")
    .select("plan_date, activity_type, half_day, note")
    .in("plan_id", [...planIds]);
  throwIfError(error);
  const byDay = new Map<string, PlannedActivityRow>();
  for (const row of (data ?? []) as Row[]) {
    const mapped = mapRow(row);
    if (mapped) byDay.set(mapped.planDate, mapped);
  }
  return byDay;
}

/** What the rep planned one day as, from his week's plan whatever its status; null when nothing. */
export async function loadPlannedActivityOn(seatId: string, isTest: boolean, date: string): Promise<PlannedActivityRow | null> {
  const supabase = getSupabaseAdmin();
  const { data: plan, error } = await supabase
    .from("phoenix_crm_plans")
    .select("id")
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .eq("week_start", fieldWeekStart(date))
    .maybeSingle();
  throwIfError(error);
  if (!plan) return null;
  const { data, error: activityError } = await supabase
    .from("phoenix_crm_plan_activities")
    .select("plan_date, activity_type, half_day, note")
    .eq("plan_id", String((plan as Row).id))
    .eq("plan_date", date)
    .maybeSingle();
  throwIfError(activityError);
  return data ? mapRow(data as Row) : null;
}

/**
 * The activities from a save body, one per day, on the days the rep may still change. Anything else
 * is dropped rather than refused: an activity is a note on the plan, never a reason to lose the plan.
 */
export function parsePlanActivities(raw: unknown, editableDays: ReadonlySet<string>): PlannedActivityDraft[] {
  if (!Array.isArray(raw)) return [];
  const byDay = new Map<string, PlannedActivityDraft>();
  for (const entry of raw) {
    const body = (entry && typeof entry === "object" ? entry : {}) as Row;
    const planDate = textOrNull(body.planDate);
    if (!planDate || !editableDays.has(planDate) || !isDayActivity(body.activityType)) continue;
    const note = textOrNull(body.note);
    byDay.set(planDate, {
      planDate,
      activityType: body.activityType,
      halfDay: body.halfDay === true,
      note: note ? note.replace(/\s+/g, " ").slice(0, PLAN_ACTIVITY_NOTE_MAX) : null,
    });
  }
  return [...byDay.values()].sort((left, right) => left.planDate.localeCompare(right.planDate));
}

/** Replace the planned activities on the editable days of one week's plan. The plan must exist. */
export async function savePlanActivities(input: {
  seatId: string;
  actorHrId: string;
  isTest: boolean;
  weekStart: string;
  editableDays: readonly string[];
  activities: readonly PlannedActivityDraft[];
}): Promise<number> {
  const result = await callPhoenixCrm<Row>("phoenix_crm_save_plan_activities", {
    p: {
      seat_id: input.seatId,
      actor_hr_id: input.actorHrId,
      is_test: input.isTest,
      week_start: input.weekStart,
      editable_days: input.editableDays,
      activities: input.activities.map((activity) => ({
        plan_date: activity.planDate,
        activity_type: activity.activityType,
        half_day: activity.halfDay,
        note: activity.note,
      })),
    },
  });
  return Number(result.activity_count ?? 0);
}
