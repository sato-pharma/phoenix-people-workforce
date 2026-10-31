/**
 * Phoenix CRM — "I started working": the write, and the day's read.
 *
 * The rule itself, and the owner's words, live in `day-start-rules.ts`. This file does three things:
 * the territory's own rep writes one row per visit day, the day screen reads it back, and his
 * district manager and the SFE Manager are told the time and the place.
 *
 * 🔴 THE DATE IS NEVER TAKEN FROM THE BODY, and neither is the time. `viewer.visitDay` decides the
 * day and the database's own `now()` decides the moment — the same closure the module put on
 * back-dating a visit and a day activity. A feature whose entire purpose is "when did he really
 * start" cannot accept either figure from the phone that is being asked about.
 *
 * 🔴 THE LOCATION IS REQUIRED, and this is the one place in the module where that is true of a
 * non-visit write. The owner ruled the press sends "their location and their time"; a press with no
 * reading would record a start nobody can place, which is the half of his instruction that would go
 * missing silently. The rep is told why in his own terms (`NO_FIX_FOR_A_DAY_START`) — his location is
 * switched off — and nothing about any check.
 */

import { validationError } from "@/lib/http/api-errors";
import { NO_FIX_FOR_A_DAY_START, type DayStartView } from "@/lib/phoenix-crm/day-start-rules";
import { isPlanDaySent } from "@/lib/phoenix-crm/plan-rules";
import { readTestFlag, territoryForRead, territoryForRepWrite, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPlanDayFacts, PLAN_DAY_COLUMNS, PLAN_STATUSES_WITH_SENT_DAYS } from "@/lib/phoenix-crm/server/plan-day-status";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";

type Row = Record<string, unknown>;

function mapRow(row: Row | null | undefined): DayStartView | null {
  if (!row || typeof row !== "object") return null;
  const startedAt = row.started_at;
  if (typeof startedAt !== "string") return null;
  const planned = row.planned_am_minute;
  return {
    startedAt,
    plannedAmMinute: typeof planned === "number" ? planned : null,
  };
}

/** What a rep's day screen shows: his own start, when he has pressed it. Null when he has not. */
export async function loadDayStartOn(seatId: string, isTest: boolean, date: string): Promise<DayStartView | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_day_starts")
    .select("started_at, planned_am_minute")
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .eq("started_on", date)
    .maybeSingle();
  throwIfError(error);
  return mapRow(data as Row | null);
}

/** A bounded `in (...)` per read, the same shape the Team tab's own batched queries use. */
const SEAT_CHUNK = 60;

/**
 * Every seat's start on ONE day, in one batched read — what a manager's Team tab needs for a whole
 * district, and the SFE Manager's for the whole company, without a query per rep.
 *
 * The table's unique index gives at most one row per seat per day, so the reply cannot approach
 * PostgREST's 1,000-row cap however many seats are asked for; the chunking bounds the URL, nothing
 * else. A seat with no start is simply absent from the map — the caller reads that as no press,
 * which is what the feature's rule says a manager sees.
 */
export async function loadDayStartsBySeat(
  seatIds: ReadonlyArray<string>,
  isTest: boolean,
  date: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (seatIds.length === 0) return out;
  const supabase = getSupabaseAdmin();
  // Four chunks at a time, merged in chunk order (2026-10-31, "fix the slowest five pages"): on a wide scope the chunks
  // were read one after another.
  const slices: string[][] = [];
  for (let index = 0; index < seatIds.length; index += SEAT_CHUNK) slices.push(seatIds.slice(index, index + SEAT_CHUNK));
  const answers = await mapWithConcurrency(slices, 4, async (slice) =>
    supabase.from("phoenix_crm_day_starts").select("seat_id, started_at").in("seat_id", slice).eq("is_test", isTest).eq("started_on", date),
  );
  for (const { data, error } of answers) {
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) {
      if (typeof row.started_at === "string") out.set(String(row.seat_id), row.started_at);
    }
  }
  return out;
}

/**
 * The minute his SENT plan says he starts the morning, for the day on screen — the other half of the
 * pair this feature completes. Null when he has no sent plan for the day, which is itself worth
 * knowing: he started a day he never planned.
 *
 * Read from the plan's own day row (`phoenix_crm_plan_day_starts.start_am_minute`) and SNAPSHOTTED
 * onto the start, so a plan edited later cannot change how punctual the morning looks afterwards.
 */
async function plannedAmMinuteFor(seatId: string, isTest: boolean, date: string): Promise<number | null> {
  const supabase = getSupabaseAdmin();
  // 🔴 "SENT" IS THE MODULE'S OWN QUESTION, NEVER A STATUS LIST OF MY OWN. A week RETURNED for one day
  // still stands on its other days, so a rep whose Tuesday was returned still has a planned start on
  // Saturday — a hand-rolled `in ("submitted","approved")` drops exactly that case, and drops it
  // silently. `PLAN_STATUSES_WITH_SENT_DAYS` widens the read and `isPlanDaySent` decides the day.
  const { data: plans, error: planError } = await supabase
    .from("phoenix_crm_plans")
    .select(`id, ${PLAN_DAY_COLUMNS}`)
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .in("status", [...PLAN_STATUSES_WITH_SENT_DAYS]);
  throwIfError(planError);
  const planRows = (plans ?? []) as Row[];
  if (planRows.length === 0) return null;
  const facts = await loadPlanDayFacts(planRows, isTest);
  const planIds = planRows.map((row) => String(row.id)).filter((id) => {
    const fact = facts.get(id);
    return fact ? isPlanDaySent({ ...fact, date }) : false;
  });
  if (planIds.length === 0) return null;

  const { data, error } = await supabase
    .from("phoenix_crm_plan_day_starts")
    .select("start_am_minute")
    .in("plan_id", planIds)
    .eq("plan_date", date)
    .maybeSingle();
  throwIfError(error);
  const minute = (data as Row | null)?.start_am_minute;
  return typeof minute === "number" ? minute : null;
}

export type StartDayResult = {
  dayStart: DayStartView;
  /** False when he had already pressed it today: the first press stands, and nothing is sent again. */
  created: boolean;
};

/**
 * Record that the rep has started his day.
 *
 * The territory's own rep only (`territoryForRepWrite`) — a manager enters a rep's VISIT, but not a
 * statement about when that rep got to work, which is the same boundary the day activity keeps.
 *
 * Idempotent: the RPC's unique index means a second press returns the first row untouched, and the
 * managers are told once. A rep who presses twice has not started twice.
 */
export async function startDay(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; lat?: unknown; lon?: unknown; accuracyMeters?: unknown },
): Promise<StartDayResult> {
  const { seat, isTest } = territoryForRepWrite(viewer, raw.seatId, readTestFlag(raw.test));

  const lat = typeof raw.lat === "number" && Number.isFinite(raw.lat) ? raw.lat : null;
  const lon = typeof raw.lon === "number" && Number.isFinite(raw.lon) ? raw.lon : null;
  if (lat === null || lon === null) throw validationError(NO_FIX_FOR_A_DAY_START);
  const accuracy = typeof raw.accuracyMeters === "number" && Number.isFinite(raw.accuracyMeters) ? raw.accuracyMeters : null;

  const plannedAmMinute = await plannedAmMinuteFor(seat.seatId, isTest, viewer.visitDay);

  const result = (await callPhoenixCrm("phoenix_crm_start_day", {
    p: {
      accuracy_meters: accuracy,
      is_test: isTest,
      lat,
      line_code: seat.lineCode,
      lon,
      planned_am_minute: plannedAmMinute,
      rep_hr_id: seat.occupantHrId ?? viewer.hrId,
      seat_id: seat.seatId,
    },
  })) as Row;

  const dayStart = mapRow((result?.day_start ?? null) as Row | null);
  if (!dayStart) throw validationError("That did not save. Try again.");
  const created = result?.created === true;

  // Told once, on the press that actually started the day. A repeat press sends nothing: the manager
  // has already been told, and a second ping would say a rep started twice.
  if (created) {
    await notifyPhoenixCrm(
      {
        kind: "day_start",
        org: viewer.org,
        seat,
        repHrId: seat.occupantHrId ?? viewer.hrId,
        startedAt: dayStart.startedAt,
        lat,
        lon,
        plannedAmMinute,
      },
      isTest,
    );
  }

  return { created, dayStart };
}

/** The day screen's read, for any viewer who may read the territory. */
export async function loadDayStart(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; date: unknown },
): Promise<DayStartView | null> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  const date = typeof raw.date === "string" && raw.date ? raw.date : viewer.visitDay;
  return loadDayStartOn(seat.seatId, isTest, date);
}
