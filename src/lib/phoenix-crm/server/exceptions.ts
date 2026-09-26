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
 *   3. Those plans' items, counted per plan.
 *   4. Countable visits over the rolling window, which also answers the last field day.
 *
 * 🔴 The visits read is `phoenix_crm_countable_visits`, never `phoenix_crm_visits`. An off-plan visit
 * waiting for approval counts in NOTHING until it is approved (owner, 2026-09-26), and a board that
 * counted it would quietly tell a manager a rep is fine on a day whose visits may yet be refused.
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

import { forbiddenError } from "@/lib/http/api-errors";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import {
  RATE_WINDOW_FIELD_DAYS,
  buildExceptions,
  isFieldDay,
  lastFinishedFieldDay,
  type ExceptionsBoard,
  type TerritoryFacts,
} from "@/lib/phoenix-crm/exceptions";
import { territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { readTestFlag, readsTeamReports, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk } from "@/lib/phoenix-crm/server/db";
import { loadReadiness, type SeatReadiness } from "@/lib/phoenix-crm/server/list";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export type ExceptionsView = ExceptionsBoard & {
  isTest: boolean;
  /** The day `no_visit` speaks about — printed on the board so nobody has to guess which day it means. */
  lastFieldDay: string;
  /** The field week the two plan kinds speak about. */
  weekStart: string;
  windowFieldDays: number;
};

/** The field days the window covers, counting back from the last finished one. */
function windowDays(lastDay: string, count: number): string[] {
  const days: string[] = [];
  const date = new Date(`${lastDay}T00:00:00Z`);
  while (days.length < Math.max(1, count)) {
    const day = date.toISOString().slice(0, 10);
    if (isFieldDay(day)) days.push(day);
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return days.reverse();
}

/** This field week's plan header per seat, and how many customers each one holds. */
async function loadPlanFacts(
  seatIds: string[],
  isTest: boolean,
  weekStart: string,
): Promise<Map<string, { status: string; items: number }>> {
  const out = new Map<string, { status: string; items: number }>();
  if (seatIds.length === 0) return out;

  const planRows: Row[] = [];
  for (const part of chunk(seatIds, 150)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_plans")
          .select("id, seat_id, status")
          .eq("is_test", isTest)
          .eq("week_start", weekStart)
          .in("seat_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    planRows.push(...rows);
  }
  if (planRows.length === 0) return out;

  const planIds = planRows.map((row) => String(row.id));
  const itemCounts = new Map<string, number>();
  for (const part of chunk(planIds, 150)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_plan_items").select("id, plan_id").in("plan_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const row of rows) {
      const planId = String(row.plan_id);
      itemCounts.set(planId, (itemCounts.get(planId) ?? 0) + 1);
    }
  }

  for (const row of planRows) {
    out.set(String(row.seat_id), { status: String(row.status), items: itemCounts.get(String(row.id)) ?? 0 });
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

  for (const part of chunk(seatIds, 150)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_countable_visits")
          .select("id, seat_id, visit_date, list_type")
          .eq("is_test", isTest)
          .gte("visit_date", from)
          .lte("visit_date", to)
          .in("seat_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const row of rows) {
      const seatId = String(row.seat_id);
      const tally = out.get(seatId) ?? { am: 0, pm: 0, lastDay: 0 };
      if (row.list_type === "AM") tally.am += 1;
      else tally.pm += 1;
      if (String(row.visit_date) === lastDay) tally.lastDay += 1;
      out.set(seatId, tally);
    }
  }
  return out;
}

/**
 * The board over an explicit set of seats — the one gathering, shared by the screen and the cron.
 *
 * The 06:55 digest has no viewer to scope by and reads a window of ONE day, so it calls this
 * directly. Keeping it as one function is what stops the two answering differently about the same
 * territory on the same morning, which is exactly the kind of drift nobody notices for a month.
 */
export async function gatherExceptions(input: {
  seats: ReadonlyArray<OrgSeat>;
  isTest: boolean;
  cairoToday: string;
  config: PhoenixCrmViewer["config"];
  /** How many finished field days the call rate reads. The board uses six; the digest uses one. */
  windowFieldDays: number;
}): Promise<ExceptionsView> {
  const { config, isTest, seats } = input;
  const seatIds = seats.map((seat) => seat.seatId);
  const lastDay = lastFinishedFieldDay(input.cairoToday);
  const window = windowDays(lastDay, input.windowFieldDays);
  const weekStart = fieldWeekStart(input.cairoToday);

  const [readiness, plans, visits, names] = await Promise.all([
    // Readiness is measured on real entries; in test mode nothing is claimed about a list.
    isTest || seatIds.length === 0 ? Promise.resolve(new Map<string, SeatReadiness>()) : loadReadiness(seatIds),
    loadPlanFacts(seatIds, isTest, weekStart),
    loadVisitTallies(seatIds, isTest, window[0], lastDay, lastDay),
    loadPeopleNames(seats.map((seat) => seat.occupantHrId)),
  ]);

  const openedOn = new Map(config.lineRollout.map((line) => [line.lineCode, line.opensOn]));

  const facts: TerritoryFacts[] = seats.map((seat) => {
    const list = readiness.get(seat.seatId) ?? null;
    const plan = plans.get(seat.seatId) ?? null;
    const tally = visits.get(seat.seatId) ?? { am: 0, pm: 0, lastDay: 0 };
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
      planItems: plan?.items ?? 0,
      windowFieldDays: window.length,
      windowAmVisits: tally.am,
      windowPmVisits: tally.pm,
      lastFieldDayVisits: tally.lastDay,
    };
  });

  const board = buildExceptions(facts, {
    callRateAmTarget: config.settings.callRateAmTarget,
    callRatePmTarget: config.settings.callRatePmTarget,
    cairoToday: input.cairoToday,
  });

  return { ...board, isTest, lastFieldDay: lastDay, weekStart, windowFieldDays: window.length };
}

export async function loadExceptionsBoard(viewer: PhoenixCrmViewer, raw: { test: unknown }): Promise<ExceptionsView> {
  if (!readsTeamReports(viewer)) throw forbiddenError("The exceptions board is for managers.");
  const isTest = readTestFlag(raw.test);
  if (isTest && !viewer.isSuperAdmin) throw forbiddenError("Test entries are the Super Admin's.");
  return gatherExceptions({
    seats: isTest ? viewer.org.territories : viewer.scopeTerritories,
    isTest,
    cairoToday: viewer.cairoToday,
    config: viewer.config,
    windowFieldDays: RATE_WINDOW_FIELD_DAYS,
  });
}
