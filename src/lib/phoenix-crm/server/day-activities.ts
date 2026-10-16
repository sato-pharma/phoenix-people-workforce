import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { dayActivityLabel, parseDayActivityDraft, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { isActivityEnteredForRep } from "@/lib/phoenix-crm/missed-records";
import { readTestFlag, territoryForRead, territoryForRepWrite, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { validationError } from "@/lib/http/api-errors";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Phoenix CRM — day activities: a working day that was not a call.
 *
 * Owner, 2026-09-26, and the two rulings that shape every line here: it is a **record only** (no call
 * rate, no coverage, no plan-against-actual moves because of it) and **leave is not in Phoenix CRM**
 * (HR's vacation module stays the only leave record).
 *
 * Nothing in this file is read by a `phoenix_crm_report_*` function, and nothing here reads one. That
 * separation is the ruling, written down. Since 2026-10-01 the plan-against-actual SCREEN prints the
 * day's activity beside its misses ("show it beside the miss") through `loadSeatDayActivities` — shown,
 * never counted, and `tests/phoenix-crm-day-activities` holds that it never reaches a figure.
 */

type Row = Record<string, unknown>;

export type DayActivityRow = {
  activityDate: string;
  activityType: PhoenixCrmDayActivity;
  activityLabel: string;
  halfDay: boolean;
  note: string | null;
  /**
   * Entered for the rep by the Super Admin — a day he missed recording (owner, 2026-10-01). Only the
   * rep writes his own day, so anyone else who did is the Super Admin (`isActivityEnteredForRep`).
   */
  enteredByAdmin: boolean;
};

/** Who wrote the day and for whom ride along, so the row can say it was entered for him. */
const DAY_ACTIVITY_COLUMNS = "activity_date, activity_type, half_day, note, entered_by_hr_id, rep_hr_id";

/**
 * One stored day activity, as every screen reads it. Exported for the Super Admin's missed-record save,
 * which shapes the row the save function hands back rather than reading the day a second time.
 */
export function mapDayActivityRow(row: Row): DayActivityRow | null {
  const activityType = textOrNull(row.activity_type);
  const activityDate = textOrNull(row.activity_date);
  if (!activityType || !activityDate) return null;
  return {
    activityDate,
    activityType: activityType as PhoenixCrmDayActivity,
    activityLabel: dayActivityLabel(activityType as PhoenixCrmDayActivity),
    halfDay: row.half_day === true,
    note: textOrNull(row.note),
    enteredByAdmin: isActivityEnteredForRep({ enteredBy: row.entered_by_hr_id, rep: row.rep_hr_id }),
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
    .select(DAY_ACTIVITY_COLUMNS)
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .eq("activity_date", date)
    .maybeSingle();
  throwIfError(error);
  return data ? mapDayActivityRow(data as Row) : null;
}

/**
 * Every territory's day activities between two days, keyed `seatId|date` — for plan against actual,
 * which SHOWS the day's activity beside its misses (owner, 2026-10-01: "show it beside the miss").
 *
 * 🔴 SHOWN, NEVER COUNTED — the 2026-09-26 ruling at the top of this file stands: a day activity
 * moves no plan-against-actual figure. A planned customer missed on a meeting day is still missed;
 * the manager reads WHY beside it. The caller has already scoped the territories, so no access test
 * is repeated here.
 */
export async function loadSeatDayActivities(
  seatIds: readonly string[],
  isTest: boolean,
  range: { from: string; to: string },
): Promise<Map<string, DayActivityRow>> {
  const out = new Map<string, DayActivityRow>();
  if (seatIds.length === 0) return out;
  for (const part of chunk([...seatIds], 150)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_day_activities")
          .select(`id, seat_id, ${DAY_ACTIVITY_COLUMNS}`)
          .eq("is_test", isTest)
          .gte("activity_date", range.from)
          .lte("activity_date", range.to)
          .in("seat_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const row of rows) {
      const activity = mapDayActivityRow(row);
      const seatId = textOrNull(row.seat_id);
      if (activity && seatId) out.set(`${seatId}|${activity.activityDate.slice(0, 10)}`, activity);
    }
  }
  return out;
}

/** The day activities on one territory between two days, newest first. */
export async function loadDayActivities(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; from?: unknown; to?: unknown },
): Promise<{ rows: DayActivityRow[] }> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  const to = isIsoDay(raw.to) ? raw.to : viewer.visitDay;
  const from = isIsoDay(raw.from) ? raw.from : to;

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_day_activities")
    .select(DAY_ACTIVITY_COLUMNS)
    .eq("seat_id", seat.seatId)
    .eq("is_test", isTest)
    .gte("activity_date", from)
    .lte("activity_date", to)
    .order("activity_date", { ascending: false });
  throwIfError(error);

  return { rows: ((data ?? []) as Row[]).flatMap((row) => mapDayActivityRow(row) ?? []) };
}

/**
 * Write or clear one day's activity.
 *
 * The territory's own rep, exactly like his list and his plan — `territoryForRepWrite`. A manager
 * enters a VISIT on a rep's territory (he was there, with him) but never a day activity, which is a
 * statement about how the rep spent his own day.
 *
 * The date is the viewer's VISIT day and is not taken from the body: back-dating a day activity is
 * the same hole as back-dating a visit, and the module closed that one already. Since 2026-09-29 that
 * day runs until 02:00 the next morning, exactly as a visit's does (`viewer.visitDay`).
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
        activity_date: viewer.visitDay,
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
      activity_date: viewer.visitDay,
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

  return { cleared: false, activity: mapDayActivityRow(result) };
}
