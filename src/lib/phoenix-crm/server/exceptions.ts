/**
 * Phoenix CRM — the exceptions board, gathered.
 *
 * The I/O half of `src/lib/phoenix-crm/exceptions.ts`, which holds every rule. Nothing here decides
 * anything: it fetches four things for every territory in the viewer's scope and hands them to
 * `buildExceptions`.
 *
 * ## Four reads for the whole board, whatever its size
 *
 * A District Manager has a handful of seats; the SFE Manager and the Super Admin have about 140. The
 * obvious shape — one readiness call, one plan read and one visit read PER TERRITORY — is 420 round
 * trips for the person who opens this most. So each of the four is one query over every seat at once,
 * and the per-territory arithmetic happens in memory:
 *
 *   1. `phoenix_crm_seat_readiness` for every seat (the RPC already takes an array).
 *   2. This field week's plan headers.
 *   3. Those plans' items, counted per plan — in the database (`phoenix_crm_plan_item_counts`).
 *   4. Countable visits over the rolling window, which also answers the last working day.
 *
 * Beside them, one lookup that is not per seat at all: the national holidays (`loadCallRateHolidays`,
 * at most two reads, since it reads per calendar month). It runs before the visits and the leave,
 * because it decides which days the window is made of — see `gatherExceptions`; 1 and 2 and the names
 * do not depend on it, so they run beside it.
 *
 * 🔴 The visits read is `phoenix_crm_countable_visits`, never `phoenix_crm_visits`, and it asks that
 * view for `customer_validated = true`. An off-plan visit waiting for approval counts in NOTHING
 * until it is approved (owner, 2026-09-26), and a board that counted it would quietly tell a manager
 * a rep is fine on a day whose visits may yet be refused. The customer's own admission to the list is
 * the second half of the same question (owner, 2026-10-01) and fails the same quiet way.
 *
 * ## It reads nothing of the integrity evidence
 *
 * Every kind here is about work not done. The mock-location evidence table is not imported, not read,
 * and must never be: that board is the Super Admin's and the SFE's alone and it is silent by the
 * owner's rule. This one is deliberately made of facts the rep can already see about himself.
 *
 * 🔴 Its NAME is deliberately not written anywhere in this file. `tests/phoenix-crm-blind-half.test.ts`
 * sweeps for the literal table name and does NOT strip comments for that check, so even saying
 * "we never read X" here declares this file a reader of X — which it caught on the first run.
 */

import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import { forbiddenError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { loadApprovedLeaveDays } from "@/lib/vacation/approved-leave-days";
import { addDaysIso } from "@/lib/crm/dates";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import {
  RATE_WINDOW_WORKING_DAYS,
  buildExceptions,
  isWorkingDay,
  lastFinishedWorkingDay,
  type ExceptionsBoard,
  type TerritoryFacts,
} from "@/lib/phoenix-crm/exceptions";
import { territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { readsTeamReports, testModeFor, testReadSeats, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk } from "@/lib/phoenix-crm/server/db";
import { loadReadiness, type SeatReadiness } from "@/lib/phoenix-crm/server/list";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadPlanDayFacts, PLAN_DAY_COLUMNS } from "@/lib/phoenix-crm/server/plan-day-status";
import { readSeatGroups, shareInFlight, startedEarly } from "@/lib/phoenix-crm/server/reports";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { CallRateHolidays } from "@/lib/crm/call-rate";

type Row = Record<string, unknown>;

export type ExceptionsView = ExceptionsBoard & {
  isTest: boolean;
  /**
   * The day `no_visit` speaks about — printed on the board so nobody has to guess which day it
   * means. NULL when no working day has finished inside the last month (a long holiday run), and the
   * board then says nothing about any day rather than judging one that has not ended.
   */
  lastWorkingDay: string | null;
  /** The field week the two plan kinds speak about. */
  weekStart: string;
  windowWorkingDays: number;
  /**
   * 🔴 The holiday calendar could not be read, so a public holiday may still be sitting in the call
   * rate's denominator and a rate may read LOW for a reason nobody performed. Said on the board: a
   * failed data source must never read as a real answer.
   */
  holidaysUnread: boolean;
  /**
   * 🔴 The approved-leave calendar could not be read, so a rep who is signed off may still be
   * sitting in the exception rows — the very accusation this board stopped making on 2026-10-03.
   * Said out loud for the same reason as `holidaysUnread`: a failed data source must never read as a
   * real answer, and "nobody is on leave" is the one wrong answer that invents work for a manager.
   */
  leaveUnread: boolean;
};

/**
 * How far back the holiday lookup reaches. The window walks back six WORKING days, which is nine
 * calendar days of ordinary weeks and more across a holiday run — 45 days covers the longest Eid
 * plus both weekends with room to spare, and costs at most two reads (the lookup is per month).
 */
const HOLIDAY_LOOKBACK_DAYS = 45;

/** The working days the window covers, counting back from the last finished one. */
function windowDays(lastDay: string, count: number, holidays: CallRateHolidays): string[] {
  const days: string[] = [];
  const date = new Date(`${lastDay}T00:00:00Z`);
  // Bounded: with holidays out, a run of non-working days is finite but not two days long, and an
  // unbounded walk would spin on a calendar that answered "holiday" for everything.
  for (let back = 0; back < 90 && days.length < Math.max(1, count); back += 1) {
    const day = date.toISOString().slice(0, 10);
    if (isWorkingDay(day, holidays)) days.push(day);
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return days.reverse();
}

/**
 * How many items each plan holds, counted by `phoenix_crm_plan_item_counts`. A plan with none has no
 * row and reads 0, exactly as an empty tally did. 500 plans a call keeps every answer under PostgREST's
 * 1,000-row cap (one row per plan), and the calls run four at a time.
 */
async function loadPlanItemCounts(planIds: string[]): Promise<Map<string, number>> {
  const answers = await mapWithConcurrency(chunk(planIds, 500), 4, (part) =>
    callPhoenixCrm<unknown>("phoenix_crm_plan_item_counts", { p_plan_ids: part }),
  );
  const counts = new Map<string, number>();
  for (const answer of answers) {
    for (const row of (Array.isArray(answer) ? answer : []) as Row[]) {
      counts.set(String(row.plan_id), Number(row.items ?? 0));
    }
  }
  return counts;
}

/** This field week's plan header per seat, how many customers it holds, and its standing returned day. */
async function loadPlanFacts(
  seatIds: string[],
  isTest: boolean,
  weekStart: string,
): Promise<Map<string, { status: string; items: number; returnedDay: string | null }>> {
  const out = new Map<string, { status: string; items: number; returnedDay: string | null }>();
  if (seatIds.length === 0) return out;

  const planRows: Row[] = [];
  for (const part of chunk(seatIds, 150)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_plans")
          .select(`id, seat_id, ${PLAN_DAY_COLUMNS}`)
          .eq("is_test", isTest)
          .eq("week_start", weekStart)
          .in("seat_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    planRows.push(...rows);
  }
  if (planRows.length === 0) return out;

  const planIds = planRows.map((row) => String(row.id));
  // 🔴 The STANDING one-day return, through the module's one reader — never `returned_day` raw. A
  // week whose edit request was acknowledged after the return is open to the rep again, so no day of
  // it stands as sent, and `loadPlanDayFacts` is the only thing that knows that.
  //
  // Beside it, how many customers each plan holds — COUNTED in the database
  // (`phoenix_crm_plan_item_counts`, 2026-10-16) rather than every item row carried here to be
  // counted: a whole company's week was some ten thousand rows in pages of a thousand, one after the
  // other, to produce one number per plan. The two reads are independent, so they run together.
  const [dayFacts, itemCounts] = await Promise.all([loadPlanDayFacts(planRows, isTest), loadPlanItemCounts(planIds)]);

  for (const row of planRows) {
    const id = String(row.id);
    out.set(String(row.seat_id), {
      status: String(row.status),
      items: itemCounts.get(id) ?? 0,
      returnedDay: dayFacts.get(id)?.returnedDay ?? null,
    });
  }
  return out;
}

type VisitTally = { am: number; pm: number; lastDay: number };

/**
 * Visits per seat over the window, and on the last finished field day.
 *
 * AM and PM are tallied APART and never summed into a rate — the call-rate golden rule. `lastDay` is
 * the one place they are added, and only to answer "was there anything at all?", which is a different
 * question from a rate and is never printed as one.
 *
 * 🔴 `customer_validated = true`, AND ON THIS BOARD THE OMISSION FAILS QUIET. Owner, 2026-10-01: a
 * customer may be planned and visited before he is validated, "but not counted in KPIs till
 * validated". Here an inflated tally does not show up as a wrong number on a screen — it REMOVES a
 * row, because this board exists to raise the territory whose count is low. So a rep whose whole
 * window was visits to customers nobody has validated would read as a rep who worked, and the one
 * exception worth seeing is the one that never appears.
 */
async function loadVisitTallies(
  seatIds: string[],
  isTest: boolean,
  from: string,
  to: string,
  lastDay: string,
): Promise<Map<string, VisitTally>> {
  const out = new Map<string, VisitTally>();
  if (seatIds.length === 0) return out;

  // Groups of territories four at a time, the same rows as one walk per batch of 150 (`readSeatGroups`).
  const rows = await readSeatGroups(seatIds, 150, (part) =>
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_countable_visits")
          .select("id, seat_id, visit_date, list_type")
          .eq("is_test", isTest)
          .eq("customer_validated", true)
          // A visit copied from iReports360 history (20261029212200) is the old system's; nothing here judges it.
          .is("imported_from_ireports360_at", null)
          .gte("visit_date", from)
          .lte("visit_date", to)
          .in("seat_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  );
  for (const row of rows) {
    const seatId = String(row.seat_id);
    const tally = out.get(seatId) ?? { am: 0, pm: 0, lastDay: 0 };
    if (row.list_type === "AM") tally.am += 1;
    else tally.pm += 1;
    if (String(row.visit_date) === lastDay) tally.lastDay += 1;
    out.set(seatId, tally);
  }
  return out;
}

/**
 * Readiness for every territory, shared with a caller asking for the same territories AT THE SAME
 * MOMENT — the reports pack opens this board and the adoption report together, and both open with
 * this call (`shareInFlight`; nothing is kept once it lands). `loadReadiness` answers territory by
 * territory, so the set is keyed sorted and de-duplicated; both boards only ever `get` from the map.
 */
export function sharedReadiness(seatIds: string[]): Promise<Map<string, SeatReadiness>> {
  const key = `phoenix-crm:readiness|${[...new Set(seatIds)].sort().join(",")}`;
  return shareInFlight(key, () => loadReadiness(seatIds));
}

/**
 * The board over an explicit set of seats — the one gathering, shared by the screen and the cron.
 *
 * The 06:55 digest has no viewer to scope by and reads a window of ONE day, so it calls this
 * directly. Keeping it as one function is what stops the two answering differently about the same
 * territory on the same morning, which is exactly the kind of drift nobody notices for a month.
 *
 * 🔴 EVERY DAY IT COUNTS IS A WORKING DAY — Saturday to Wednesday, national holidays out, the
 * owner's own call-rate rule (`isWorkingDay`). Before 2026-10-02 it excluded Friday alone, so a rep
 * with a perfect 10 PM calls on each of Saturday to Wednesday read 50 / 6 = 8.3 and was listed
 * "Below the PM call rate", and the digest judged a Thursday that holds no PM by design.
 */
export async function gatherExceptions(input: {
  seats: ReadonlyArray<OrgSeat>;
  isTest: boolean;
  cairoToday: string;
  config: PhoenixCrmViewer["config"];
  /** How many finished WORKING days the call rate reads. The board uses six; the digest uses one. */
  windowWorkingDays: number;
}): Promise<ExceptionsView> {
  const { config, isTest, seats } = input;
  const seatIds = seats.map((seat) => seat.seatId);
  const weekStart = fieldWeekStart(input.cairoToday);

  // Readiness, the week's plans and the names depend on nothing the holidays decide, so they start
  // NOW — beside the holiday and leave reads rather than after them. Their failure is held
  // (`startedEarly`) and surfaces where it is awaited, below, exactly as it always did.
  const independent = startedEarly(
    Promise.all([
      // Readiness is measured on real entries; in test mode nothing is claimed about a list.
      isTest || seatIds.length === 0 ? Promise.resolve(new Map<string, SeatReadiness>()) : sharedReadiness(seatIds),
      loadPlanFacts(seatIds, isTest, weekStart),
      loadPeopleNames(seats.map((seat) => seat.occupantHrId)),
    ]),
  );

  // 🔴 THE HOLIDAYS COME FIRST, because they decide which days the window is even made of. Read
  // over the whole lookback rather than the window, since the window's own length depends on them.
  const holidays = await loadCallRateHolidays(addDaysIso(input.cairoToday, -HOLIDAY_LOOKBACK_DAYS), input.cairoToday);
  const lastDay = lastFinishedWorkingDay(input.cairoToday, holidays.dates);
  const window = lastDay ? windowDays(lastDay, input.windowWorkingDays, holidays.dates) : [];

  // 🔴 THE FIELD WEEK'S OWN WORKING DAYS — Saturday to Wednesday minus holidays, the same rule as
  // the window, never a bare seven days. This is what "signed off all week" has to be measured
  // against: a week with a holiday Thursday in it was never a seven-day obligation.
  const weekWorkingDays = Array.from({ length: 7 }, (_, offset) => addDaysIso(weekStart, offset)).filter((day) =>
    isWorkingDay(day, holidays.dates),
  );

  // The window's visits, read beside the leave rather than after it. No finished working day means no
  // window: nothing is read and no rate is claimed.
  const visitsRead = startedEarly(
    lastDay ? loadVisitTallies(seatIds, isTest, window[0] as string, lastDay, lastDay) : Promise.resolve(new Map<string, VisitTally>()),
  );

  // 🔴 A FAILED LEAVE READ MUST NEVER READ AS "nobody is on leave" — that is the one direction that
  // invents an accusation. `loadApprovedLeaveDays` throws, so it is caught and the failure travels
  // as `leaveUnread` for the board to say out loud, exactly as `holidaysUnread` does.
  const leaveSpan = [...window, ...weekWorkingDays, input.cairoToday].sort();
  let leaveRows: Array<{ hrId: string; day: string; fullDay: boolean }> = [];
  let leaveUnread = false;
  try {
    leaveRows = await loadApprovedLeaveDays(
      seats.map((seat) => seat.occupantHrId),
      { from: leaveSpan[0] as string, to: leaveSpan[leaveSpan.length - 1] as string },
    );
  } catch (error) {
    leaveUnread = true;
    logError("Phoenix CRM exceptions board could not read approved leave", {
      error,
      labels: { event: "phoenix_crm_exceptions_leave_unread" },
    });
  }

  // HR ids are MIXED CASE in this database, so both sides are lowered — a plain match silently
  // under-returns, and here that would read as "not on leave".
  const fullLeave = new Map<string, Set<string>>();
  for (const row of leaveRows) {
    if (!row.fullDay) continue;
    const key = String(row.hrId ?? "").trim().toLowerCase();
    if (!key) continue;
    if (!fullLeave.has(key)) fullLeave.set(key, new Set<string>());
    (fullLeave.get(key) as Set<string>).add(row.day);
  }

  const [[readiness, plans, names], visits] = await Promise.all([independent, visitsRead]);

  const openedOn = new Map(config.lineRollout.map((line) => [line.lineCode, line.opensOn]));

  const facts: TerritoryFacts[] = seats.map((seat) => {
    const list = readiness.get(seat.seatId) ?? null;
    const plan = plans.get(seat.seatId) ?? null;
    const tally = visits.get(seat.seatId) ?? { am: 0, pm: 0, lastDay: 0 };
    const away = fullLeave.get(String(seat.occupantHrId ?? "").trim().toLowerCase()) ?? new Set<string>();
    return {
      seatId: seat.seatId,
      territoryName: territoryName(seat),
      lineName: seat.lineName,
      repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
      hasRep: Boolean(seat.occupantHrId),
      lineOpenedOn: (seat.lineCode ? openedOn.get(seat.lineCode) : null) ?? null,
      readiness: list
        ? { total: list.total, validated: list.validated, dropped: list.dropped, dropPending: list.dropPending, ready: list.ready }
        : null,
      planStatus: plan ? (plan.status as TerritoryFacts["planStatus"]) : null,
      planReturnedDay: plan?.returnedDay ?? null,
      planItems: plan?.items ?? 0,
      windowWorkingDays: window.length,
      windowAmVisits: tally.am,
      windowPmVisits: tally.pm,
      lastWorkingDayVisits: lastDay ? tally.lastDay : null,
      leaveFullDaysInWindow: window.filter((day) => away.has(day)).length,
      leaveOnLastWorkingDay: Boolean(lastDay && away.has(lastDay)),
      // "All week" means every working day the week actually had. An empty week (every day a
      // holiday) is NOT "on leave" — `weekWorkingDays.length > 0` keeps a holiday run from reading
      // as everyone being signed off.
      leaveCoversWholeWeek: weekWorkingDays.length > 0 && weekWorkingDays.every((day) => away.has(day)),
    };
  });

  const board = buildExceptions(facts, {
    callRateAmTarget: config.settings.callRateAmTarget,
    callRatePmTarget: config.settings.callRatePmTarget,
    cairoToday: input.cairoToday,
  });

  return {
    ...board,
    holidaysUnread: !holidays.complete,
    leaveUnread,
    isTest,
    lastWorkingDay: lastDay,
    weekStart,
    windowWorkingDays: window.length,
  };
}

export async function loadExceptionsBoard(viewer: PhoenixCrmViewer, raw: { test: unknown }): Promise<ExceptionsView> {
  if (!readsTeamReports(viewer)) throw forbiddenError("The exceptions board is for managers.");
  const isTest = testModeFor(viewer, raw.test);
  return gatherExceptions({
    seats: testReadSeats(viewer, isTest, viewer.scopeTerritories),
    isTest,
    cairoToday: viewer.cairoToday,
    config: viewer.config,
    windowWorkingDays: RATE_WINDOW_WORKING_DAYS,
  });
}
