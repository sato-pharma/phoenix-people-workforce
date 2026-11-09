/**
 * Phoenix CRM — the district manager's double-visit plan: who reads it, who writes it, and the plan
 * against what happened. The rules, with no I/O, are double-visit-plan-rules.ts.
 *
 * Owner, 2026-10-02: the district manager plans, for the coming field week, which of his reps he joins
 * on which day, AM or PM; after the day each planned half-day reads done or not done.
 *
 * 🔴 THE REP DOES NOT SEE IT (his answer that day: "Rep does not see it"). Gate two, after the route's
 * `phoenix_crm` permission:
 *   - the district manager — app role District Manager, on a DM or acting DM seat — reads and writes
 *     his OWN plan, for the reps of his own team. Another district manager's plan is refused to him;
 *   - the SFE Manager reads every district manager's plan (real entries, the open lines) and writes
 *     none;
 *   - the Super Admin reads every district manager's plan, and writes one only in the test world, as
 *     the district manager he chooses (owner, 2026-09-16: his entries are test entries);
 *   - a test account works as the district manager it mirrors, in the test world only
 *     (docs/test-accounts.md);
 *   - everyone else — a rep, a regional or national manager, the CEO — is refused.
 *
 * Nothing here notifies anyone, and every read and write is in ONE world: `is_test` on every query.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { conflictError, forbiddenError, notFoundError, validationError, type ApiError } from "@/lib/http/api-errors";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import {
  buildDoubleVisitDays,
  countsAsManagersDoubleVisit,
  defaultDoubleVisitWeek,
  districtManagers,
  DOUBLE_VISIT_PLANNER_ROLE,
  doubleVisitKey,
  doubleVisitSummaryText,
  doubleVisitTeam,
  doubleVisitWeekName,
  doubleVisitWeeks,
  isDoubleVisitHalf,
  isDoubleVisitWeek,
  plannerSeats,
  resolveDoubleVisitSlot,
  summarizeDoubleVisitWeek,
  type DoubleVisitDayPlan,
  type DoubleVisitHalf,
  type DoubleVisitOutcome,
  type DoubleVisitSlotRefusalKind,
  type DoubleVisitStoredSlot,
  type DoubleVisitSummary,
} from "@/lib/phoenix-crm/double-visit-plan-rules";
import { personKey, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { readWorldFor, superAdminHasNoFieldWrite, testModeFor, testReadSeats, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, seatScoped, textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { loadPlanHolidays } from "@/lib/phoenix-crm/server/plan-holidays";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

// ── Who reads, who writes ───────────────────────────────────────────────────────────────────────

export type DoubleVisitPlanMode = "own" | "pick";

/**
 * Whose plans the viewer reads: "own" — his own, as the district manager; "pick" — any district
 * manager's, chosen on screen (the SFE Manager, the Super Admin). `canWrite`: he may change the open
 * days of the plan on screen.
 */
export type DoubleVisitPlanReach = { mode: DoubleVisitPlanMode; canWrite: boolean };

const NOT_FOR_YOU = "Only the district manager, SFE and the Super Admin open a double visit plan.";

/** The viewer plans his own double visits: app role District Manager, on a DM or acting DM seat. */
export function isDoubleVisitPlanner(viewer: PhoenixCrmViewer): boolean {
  return viewer.role === DOUBLE_VISIT_PLANNER_ROLE && plannerSeats(viewer.org, viewer.hrId).length > 0;
}

/**
 * Whose double-visit plans the viewer reads in `isTest`'s world, and whether he writes them — the
 * answer the Team tab offers the section on. Null for everyone the server refuses, so the section is
 * never offered to somebody it would turn away.
 */
export function doubleVisitPlanReach(viewer: PhoenixCrmViewer, isTest: boolean): DoubleVisitPlanReach | null {
  if (viewer.isSuperAdmin && !viewer.isTestPersona) return { mode: "pick", canWrite: isTest && viewer.canCreate };
  // SFE reads the real plans. The test world is the Super Admin's and the test accounts'.
  if (viewer.isSfeManager && !viewer.isTestPersona) return isTest ? null : { mode: "pick", canWrite: false };
  if (isDoubleVisitPlanner(viewer)) {
    // A test account READS its district manager's real plan (owner, 2026-11-09, "Real data everywhere")
    // and writes in the test world only; a real one is in the real world only.
    if (viewer.isTestPersona && !isTest) return { mode: "own", canWrite: false };
    if (viewer.isTestPersona !== isTest) return null;
    return { mode: "own", canWrite: viewer.canCreate };
  }
  return null;
}

/** The district managers a "pick" viewer chooses between: every district for the Super Admin, the open lines for SFE. */
function reachableManagers(viewer: PhoenixCrmViewer): Array<{ hrId: string; seat: OrgSeat }> {
  if (viewer.isSuperAdmin) return districtManagers(viewer.org);
  return districtManagers(viewer.org, (seat) => Boolean(seat.lineCode && viewer.openLines.has(seat.lineCode)));
}

export type DoubleVisitPlanReader = DoubleVisitPlanReach & {
  /** Whose plan is read; null in "pick" mode until one is chosen. */
  managerHrId: string | null;
  /** "pick" mode: the district managers to choose from. */
  managers: Array<{ hrId: string; seat: OrgSeat }> | null;
};

/**
 * Gate two for READING. The district manager reads his own plan and nobody else's; the SFE Manager and
 * the Super Admin choose whose (`manager`), among the district managers they reach.
 */
export function resolveDoubleVisitPlanReader(viewer: PhoenixCrmViewer, isTest: boolean, managerParam: unknown): DoubleVisitPlanReader {
  const reach = doubleVisitPlanReach(viewer, isTest);
  if (!reach) throw forbiddenError(NOT_FOR_YOU);
  const asked = personKey(typeof managerParam === "string" ? managerParam : null);
  if (reach.mode === "own") {
    if (asked && asked !== viewer.hrId) throw forbiddenError("A district manager opens their own double visit plan only.");
    return { ...reach, managerHrId: viewer.hrId, managers: null };
  }
  const managers = reachableManagers(viewer);
  if (!asked) return { ...reach, managerHrId: null, managers };
  if (!managers.some((entry) => entry.hrId === asked)) throw notFoundError("This district manager is not in the organogram. Reload the page.");
  return { ...reach, managerHrId: asked, managers };
}

/**
 * Gate two for WRITING one half-day. Answers whose plan it is: the district manager's own — real, or in
 * the test world for a test account working as him. SFE reads and never writes; everyone else is
 * refused.
 *
 * 🔒 THE SUPER ADMIN USED TO WRITE HERE as the district manager he picked, in test mode — retired on
 * 2026-10-03 with the rest of it. He READS every district's plan as he always did; the half-day itself
 * is its own district manager's. The refusal names that, and no longer names a control that is gone.
 */
export function assertDoubleVisitPlanWriter(viewer: PhoenixCrmViewer, isTest: boolean, managerParam: unknown): string {
  const asked = personKey(typeof managerParam === "string" ? managerParam : null);
  if (viewer.isSuperAdmin && !viewer.isTestPersona) {
    throw superAdminHasNoFieldWrite("plan a district manager's double visits");
  }
  if (viewer.isSfeManager && !viewer.isTestPersona) {
    throw forbiddenError("SFE reads the district managers' double visit plans. Each district manager plans their own.");
  }
  const reach = doubleVisitPlanReach(viewer, isTest);
  if (!reach || reach.mode !== "own") throw forbiddenError(NOT_FOR_YOU);
  if (!reach.canWrite) throw forbiddenError("Your role cannot plan double visits.");
  if (asked && asked !== viewer.hrId) throw forbiddenError("A district manager plans their own double visits only.");
  return viewer.hrId;
}

// ── What the screen reads ───────────────────────────────────────────────────────────────────────

/** A rep of the manager's team, as the picker offers him. */
export type DoubleVisitRepOption = { seatId: string; repName: string; territoryName: string };

export type DoubleVisitSlotView = {
  half: DoubleVisitHalf;
  /** The rep seat planned for this half-day, or null when none is. */
  seatId: string | null;
  repName: string | null;
  territoryName: string | null;
  /** How a planned half-day went; null when nothing is planned. */
  outcome: DoubleVisitOutcome | null;
};

export type DoubleVisitDayView = {
  date: string;
  halves: DoubleVisitHalf[];
  holiday: string | null;
  editable: boolean;
  slots: DoubleVisitSlotView[];
};

/** A district manager on the SFE Manager's and the Super Admin's list, with his week in two counts. */
export type DoubleVisitManagerOption = { hrId: string; name: string; place: string; planned: number; done: number };

export type DoubleVisitPlanView = {
  isTest: boolean;
  mode: DoubleVisitPlanMode;
  /** The viewer may change the open days of the plan on screen. */
  canWrite: boolean;
  weekStart: string;
  /** Last week, this week and the coming week — the one he plans. */
  weeks: Array<{ weekStart: string; name: string }>;
  /** "pick" mode: every district manager to choose from. Null in "own" mode. */
  managers: DoubleVisitManagerOption[] | null;
  /** Whose plan is on screen (the hr id is the picker's key; the screen shows the name). Null until chosen. */
  manager: { hrId: string; name: string; place: string } | null;
  /** His team: the reps he may plan to join. */
  reps: DoubleVisitRepOption[];
  days: DoubleVisitDayView[];
  summary: DoubleVisitSummary;
  /** "Planned 3 · done 2". */
  summaryText: string;
};

const PLAN_COLUMNS = "id, manager_hr_id, plan_date, half, seat_id, rep_hr_id";

/** The week's stored half-days of these managers, in one world. */
async function loadPlanRows(managerHrIds: ReadonlyArray<string>, weekStart: string, isTest: boolean): Promise<Row[]> {
  const rows: Row[] = [];
  for (const part of chunk([...managerHrIds], 100)) {
    rows.push(
      ...(await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_double_visit_plans")
            .select(PLAN_COLUMNS)
            .in("manager_hr_id", part)
            .eq("week_start", weekStart)
            .eq("is_test", isTest),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      )),
    );
  }
  return rows;
}

/**
 * The half-days each manager was on a visit with a seat's rep — the manager report's rule, read from
 * the same countable visits every KPI reads (a planned visit, or an off-plan one once approved, on a
 * VALIDATED customer). Two reads, one per place a manager stands on a visit: the manager of a double or
 * chain visit, and the senior of a chain visit; `countsAsManagersDoubleVisit` keeps the pairs that
 * count. Keyed manager → `doubleVisitKey`s.
 */
async function loadDoneKeys(
  managerHrIds: ReadonlyArray<string>,
  seatIds: ReadonlyArray<string>,
  weekStart: string,
  isTest: boolean,
): Promise<Map<string, Set<string>>> {
  const done = new Map<string, Set<string>>();
  if (managerHrIds.length === 0 || seatIds.length === 0) return done;
  const weekEnd = addDaysIso(weekStart, 5);
  const managers = [...managerHrIds];
  const readBy = (column: "manager_hr_id" | "senior_hr_id", part: string[]) =>
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_countable_visits_with_history")
          .select("id, seat_id, visit_date, list_type, kind, manager_hr_id, senior_hr_id")
          .in("seat_id", part)
          .eq("is_test", isTest)
          .eq("customer_validated", true)
          .gte("visit_date", weekStart)
          .lte("visit_date", weekEnd)
          .in(column, managers),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
  for (const part of chunk([...seatIds], 100)) {
    const [asManager, asSenior] = await Promise.all([readBy("manager_hr_id", part), readBy("senior_hr_id", part)]);
    for (const row of [...asManager, ...asSenior]) {
      const seatId = textOrNull(row.seat_id);
      const date = textOrNull(row.visit_date)?.slice(0, 10) ?? null;
      const half = row.list_type;
      if (!seatId || !date || !isDoubleVisitHalf(half)) continue;
      const visit = { kind: row.kind, managerHrId: row.manager_hr_id, seniorHrId: row.senior_hr_id };
      for (const manager of managers) {
        if (!countsAsManagersDoubleVisit(visit, manager)) continue;
        const keys = done.get(manager) ?? new Set<string>();
        keys.add(doubleVisitKey(seatId, date, half));
        done.set(manager, keys);
      }
    }
  }
  return done;
}

function storedSlotOf(row: Row): (DoubleVisitStoredSlot & { managerHrId: string }) | null {
  const managerHrId = personKey(textOrNull(row.manager_hr_id));
  const date = textOrNull(row.plan_date)?.slice(0, 10) ?? null;
  const seatId = textOrNull(row.seat_id);
  const half = row.half;
  if (!managerHrId || !date || !seatId || !isDoubleVisitHalf(half)) return null;
  return { managerHrId, date, half, seatId, repHrId: personKey(textOrNull(row.rep_hr_id)) };
}

/** "Delta (1) · Anti Infective" — where a district manager's seat is, never its code. */
function managerPlace(seat: OrgSeat): string {
  return [seat.regionName ?? seat.areaName ?? seat.seatLabel ?? "District", seat.lineName].filter(Boolean).join(" · ");
}

function slotView(
  entry: DoubleVisitDayPlan["slots"][number],
  viewer: PhoenixCrmViewer,
  names: PeopleNames,
): DoubleVisitSlotView {
  if (!entry.slot) return { half: entry.half, seatId: null, repName: null, territoryName: null, outcome: null };
  const seat = viewer.org.seats.get(entry.slot.seatId);
  const repHrId = entry.slot.repHrId ?? seat?.occupantHrId ?? null;
  return {
    half: entry.half,
    seatId: entry.slot.seatId,
    repName: repHrId ? nameOf(names, repHrId) : "No rep in this territory",
    territoryName: seat ? territoryName(seat) : "A territory no longer in the organogram",
    outcome: entry.outcome,
  };
}

async function buildPlanView(viewer: PhoenixCrmViewer, isTest: boolean, reader: DoubleVisitPlanReader, weekStart: string): Promise<DoubleVisitPlanView> {
  const managerIds = reader.mode === "pick" ? (reader.managers ?? []).map((entry) => entry.hrId) : [viewer.hrId];
  const team = reader.managerHrId ? doubleVisitTeam(viewer.org, reader.managerHrId, testReadSeats(viewer, isTest, viewer.scopeTerritories)) : [];

  const [holidays, rows] = await Promise.all([
    loadPlanHolidays(weekStart, addDaysIso(weekStart, 5)),
    managerIds.length === 0 ? Promise.resolve([] as Row[]) : loadPlanRows(managerIds, weekStart, isTest),
  ]);
  const slotsByManager = new Map<string, DoubleVisitStoredSlot[]>();
  for (const row of rows) {
    const slot = storedSlotOf(row);
    if (!slot) continue;
    const held = slotsByManager.get(slot.managerHrId) ?? [];
    held.push({ date: slot.date, half: slot.half, seatId: slot.seatId, repHrId: slot.repHrId });
    slotsByManager.set(slot.managerHrId, held);
  }
  const plannedSeatIds = [...new Set([...slotsByManager.values()].flatMap((slots) => slots.map((slot) => slot.seatId)))];
  const [doneByManager, names] = await Promise.all([
    loadDoneKeys([...slotsByManager.keys()], plannedSeatIds, weekStart, isTest),
    loadPeopleNames([
      ...managerIds,
      ...team.map((seat) => seat.occupantHrId),
      ...[...slotsByManager.values()].flatMap((slots) => slots.map((slot) => slot.repHrId)),
    ]),
  ]);

  const daysOf = (managerHrId: string, canWrite: boolean) =>
    buildDoubleVisitDays({
      weekStart,
      cairoToday: viewer.cairoToday,
      visitDay: viewer.visitDay,
      holidays,
      slots: slotsByManager.get(managerHrId) ?? [],
      doneKeys: doneByManager.get(managerHrId) ?? new Set<string>(),
      canWrite,
    });

  const managers: DoubleVisitManagerOption[] | null =
    reader.mode === "pick"
      ? (reader.managers ?? [])
          .map((entry) => {
            const summary = summarizeDoubleVisitWeek(daysOf(entry.hrId, false));
            return { hrId: entry.hrId, name: nameOf(names, entry.hrId), place: managerPlace(entry.seat), planned: summary.planned, done: summary.done };
          })
          .sort((left, right) => left.place.localeCompare(right.place) || left.name.localeCompare(right.name))
      : null;

  const chosen = reader.managerHrId;
  const chosenSeat = chosen ? (plannerSeats(viewer.org, chosen)[0] ?? null) : null;
  const plannedDays = chosen ? daysOf(chosen, reader.canWrite) : [];
  const summary = summarizeDoubleVisitWeek(plannedDays);
  const reps = team
    .map((seat) => ({ seatId: seat.seatId, repName: nameOf(names, seat.occupantHrId), territoryName: territoryName(seat) }))
    .sort((left, right) => left.repName.localeCompare(right.repName) || left.territoryName.localeCompare(right.territoryName));

  return {
    isTest,
    mode: reader.mode,
    canWrite: reader.canWrite && chosen !== null,
    weekStart,
    weeks: doubleVisitWeeks(viewer.cairoToday).map((week) => ({ weekStart: week, name: doubleVisitWeekName(week, viewer.cairoToday) })),
    managers,
    manager: chosen ? { hrId: chosen, name: nameOf(names, chosen), place: chosenSeat ? managerPlace(chosenSeat) : "District" } : null,
    reps,
    days: plannedDays.map((day) => ({
      date: day.date,
      halves: day.halves,
      holiday: day.holiday,
      editable: day.editable,
      slots: day.slots.map((entry) => slotView(entry, viewer, names)),
    })),
    summary,
    summaryText: doubleVisitSummaryText(summary),
  };
}

/**
 * The plans between two days for these seats, for the Visit report generator (2026-10-15). That screen
 * is the Super Admin's and the SFE Manager's alone — never a rep's, never a digest — and it reads the
 * table HERE so this service stays the one place that touches it.
 */
export async function readDoubleVisitPlansForReport(
  seatIds: readonly string[],
  window: { from: string; to: string },
  includeTest: boolean,
): Promise<Row[]> {
  return fetchAllRowsKeyset<Row>(
    () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query: any = getSupabaseAdmin().from("phoenix_crm_double_visit_plans").select("id, seat_id, plan_date, half, manager_hr_id");
      query = seatScoped(query, seatIds).gte("plan_date", window.from).lte("plan_date", window.to);
      if (!includeTest) query = query.eq("is_test", false);
      return query;
    },
    { cursorColumn: "id", cursorOf: (row) => (row.id == null ? null : String(row.id)) },
  );
}

/**
 * One person's ride-along days between two days — as the district manager who planned it or as the rep
 * joined — for Expense Approvals' Phoenix CRM evidence (2026-11-07). That reading is the Super Admin
 * approver's alone; it reads the table HERE so this service stays the one place that touches it.
 */
export async function readDoubleVisitPlansForTrip(hrId: string, window: { from: string; to: string }): Promise<Row[]> {
  const read = (column: "manager_hr_id" | "rep_hr_id") =>
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_double_visit_plans")
          .select("id, plan_date, manager_hr_id, rep_hr_id")
          .eq("is_test", false)
          .eq(column, hrId)
          .gte("plan_date", window.from)
          .lte("plan_date", window.to),
      { cursorColumn: "id", cursorOf: (row) => (row.id == null ? null : String(row.id)) },
    );
  const byId = new Map<string, Row>();
  for (const rows of await Promise.all([read("manager_hr_id"), read("rep_hr_id")])) {
    for (const row of rows) byId.set(String(row.id), row);
  }
  return [...byId.values()];
}

/** GET: one week of a district manager's double-visit plan, with how each planned half-day went. */
export async function loadDoubleVisitPlan(
  viewer: PhoenixCrmViewer,
  raw: { week: unknown; manager: unknown; test: unknown },
): Promise<DoubleVisitPlanView> {
  const isTest = readWorldFor(viewer, raw.test);
  const reader = resolveDoubleVisitPlanReader(viewer, isTest, raw.manager);
  const asked = typeof raw.week === "string" && raw.week.trim() ? raw.week.trim() : null;
  const weekStart = asked ?? defaultDoubleVisitWeek(viewer.cairoToday);
  if (!isDoubleVisitWeek(weekStart, viewer.cairoToday)) throw validationError("Choose one of the weeks shown. Reload the page.");
  return buildPlanView(viewer, isTest, reader, weekStart);
}

// ── One half-day saved ──────────────────────────────────────────────────────────────────────────

function slotRefusal(kind: DoubleVisitSlotRefusalKind, message: string): ApiError {
  if (kind === "bad_input" || kind === "not_field_time") return validationError(message);
  if (kind === "not_team") return forbiddenError(message);
  return conflictError(message);
}

/**
 * POST: set, change or clear ONE half-day — the rep the manager joins, or nobody. The screen sends the
 * rep it showed for that half-day, and the database refuses the save when another screen changed it
 * first (`double_visit_changed`). Answers with the week as it now stands.
 */
export async function saveDoubleVisitSlot(viewer: PhoenixCrmViewer, raw: unknown): Promise<DoubleVisitPlanView> {
  const body = record(raw);
  const isTest = testModeFor(viewer, body.test);
  const managerHrId = assertDoubleVisitPlanWriter(viewer, isTest, body.manager);
  const date = body.date;
  // The day's own month only: a public holiday holds no double visit (server/plan-holidays.ts).
  const holidays = isIsoDay(date) ? await loadPlanHolidays(date, date) : new Map<string, string>();
  const team = doubleVisitTeam(viewer.org, managerHrId, testReadSeats(viewer, isTest, viewer.scopeTerritories));
  const resolved = resolveDoubleVisitSlot({
    date,
    half: body.half,
    seatId: body.seatId,
    expectedSeatId: body.expectedSeatId,
    cairoToday: viewer.cairoToday,
    holidays,
    team,
  });
  if (!resolved.ok) throw slotRefusal(resolved.kind, resolved.error);
  const slot = resolved.value;

  await callPhoenixCrm<Row>("phoenix_crm_save_double_visit_slot", {
    p: {
      manager_hr_id: managerHrId,
      actor_hr_id: viewer.hrId,
      plan_date: slot.date,
      half: slot.half,
      seat_id: slot.seat?.seatId ?? null,
      rep_hr_id: slot.seat?.occupantHrId ?? null,
      line_code: slot.seat?.lineCode ?? null,
      expected_seat_id: slot.expectedSeatId,
      is_test: isTest,
    },
  });

  return buildPlanView(viewer, isTest, resolveDoubleVisitPlanReader(viewer, isTest, managerHrId), slot.weekStart);
}
