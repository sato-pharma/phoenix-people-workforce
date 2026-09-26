import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { dayActivityLabel, parseDayActivityDraft, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { readTestFlag, territoryForRead, territoryForRepWrite, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { validationError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Phoenix CRM — day activities: a working day that was not a call.
 *
 * Owner, 2026-09-26, and the two rulings that shape every line here: it is a **record only** (no call
 * rate, no coverage, no plan-against-actual moves because of it) and **leave is not in Phoenix CRM**
 * (HR's vacation module stays the only leave record).
 *
 * Nothing in this file is read by a `phoenix_crm_report_*` function, and nothing here reads one. That
 * separation is the ruling, written down.
 */

type Row = Record<string, unknown>;

export type DayActivityRow = {
  activityDate: string;
  activityType: PhoenixCrmDayActivity;
  activityLabel: string;
  halfDay: boolean;
  note: string | null;
};

function mapRow(row: Row): DayActivityRow | null {
  const activityType = textOrNull(row.activity_type);
  const activityDate = textOrNull(row.activity_date);
  if (!activityType || !activityDate) return null;
  return {
    activityDate,
    activityType: activityType as PhoenixCrmDayActivity,
    activityLabel: dayActivityLabel(activityType as PhoenixCrmDayActivity),
    halfDay: row.half_day === true,
    note: textOrNull(row.note),
  };
}

/**
 * One day's activity on one territory, or null.
 *
 * Takes a seat id rather than a viewer: the visits day view has already resolved and gated the
 * territory, and a second `territoryForRead` there would be a second answer to a settled question.
 */
export async function loadDayActivityOn(seatId: string, isTest: boolean, date: string): Promise<DayActivityRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_day_activities")
    .select("activity_date, activity_type, half_day, note")
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .eq("activity_date", date)
    .maybeSingle();
  throwIfError(error);
  return data ? mapRow(data as Row) : null;
}

/** The day activities on one territory between two days, newest first. */
export async function loadDayActivities(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; from?: unknown; to?: unknown },
): Promise<{ rows: DayActivityRow[] }> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  const to = isIsoDay(raw.to) ? raw.to : viewer.cairoToday;
  const from = isIsoDay(raw.from) ? raw.from : to;

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_day_activities")
    .select("activity_date, activity_type, half_day, note")
    .eq("seat_id", seat.seatId)
    .eq("is_test", isTest)
    .gte("activity_date", from)
    .lte("activity_date", to)
    .order("activity_date", { ascending: false });
  throwIfError(error);

  return { rows: ((data ?? []) as Row[]).flatMap((row) => mapRow(row) ?? []) };
}

/**
 * Write or clear one day's activity.
 *
 * The territory's own rep, exactly like his list and his plan — `territoryForRepWrite`. A manager
 * enters a VISIT on a rep's territory (he was there, with him) but never a day activity, which is a
 * statement about how the rep spent his own day.
 *
 * The date is the viewer's Cairo today and is not taken from the body: back-dating a day activity is
 * the same hole as back-dating a visit, and the module closed that one already.
 */
export async function saveDayActivity(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; activityType?: unknown; halfDay?: unknown; note?: unknown; clear?: unknown },
): Promise<{ cleared: boolean; activity: DayActivityRow | null }> {
  const { seat, isTest } = territoryForRepWrite(viewer, raw.seatId, readTestFlag(raw.test));

  if (raw.clear === true) {
    await callPhoenixCrm("phoenix_crm_save_day_activity", {
      p: {
        actor_hr_id: viewer.hrId,
        activity_date: viewer.cairoToday,
        is_test: isTest,
        seat_id: seat.seatId,
      },
    });
    return { cleared: true, activity: null };
  }

  const parsed = parseDayActivityDraft(raw);
  if (!parsed.ok) throw validationError(parsed.error);

  const result = (await callPhoenixCrm("phoenix_crm_save_day_activity", {
    p: {
      activity_date: viewer.cairoToday,
      activity_type: parsed.value.activityType,
      actor_hr_id: viewer.hrId,
      half_day: parsed.value.halfDay,
      is_test: isTest,
      line_code: seat.lineCode,
      note: parsed.value.note,
      rep_hr_id: seat.occupantHrId,
      seat_id: seat.seatId,
    },
  })) as Row;

  return { cleared: false, activity: mapRow(result) };
}
