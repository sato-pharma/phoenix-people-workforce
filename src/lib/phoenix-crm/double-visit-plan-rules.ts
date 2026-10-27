/**
 * Phoenix CRM — the district manager's double-visit plan, with no I/O.
 *
 * Owner, 2026-10-02: the district manager (an acting district manager too — app role District
 * Manager, on a DM or ACTING_DM seat of the organogram) plans, for the coming field week, which of HIS
 * reps he joins on which day, AM or PM. After the day the plan is read against what happened.
 *
 *   - 🔴 THE REP DOES NOT SEE IT (owner, 2026-10-02: "Rep does not see it"). Not on his Plan, his
 *     Today, a notice, or anywhere else. It is the manager's own work: that district manager, the SFE
 *     Manager and the Super Admin read it, and the server refuses everyone else
 *     (server/double-visit-plans.ts). Nothing about it notifies anyone.
 *   - One rep a half-day: a day holds one AM and one PM double visit, on the plan's own field week —
 *     Saturday to Wednesday AM and PM, Thursday a morning, never a Friday (calendar.ts
 *     `planDayListTypes`). A public holiday holds nothing (server/plan-holidays.ts).
 *   - He plans this week from today on, and the coming week (calendar.ts `repPlanWeek`). A day that has
 *     passed is read-only: it is what the plan against actual reads.
 *   - DONE is the manager report's own rule (`phoenix_crm_report_manager_visits`), never a second one:
 *     a countable visit, on a validated customer, on that rep's seat, that day, in that half (the
 *     visit's list type — AM the accounts of the morning, PM the doctors of the evening), with the
 *     manager on it as the manager of a double or chain visit, or as the senior of a chain visit. A
 *     day is judged once its visit day has closed (02:00 Cairo the next morning, calendar.ts
 *     `cairoBusinessDay`): until then a half-day with nothing logged is still open, never "not done".
 */

import { addDaysIso } from "@/lib/crm/dates";
import { fieldWeekDays, fieldWeekStart, isIsoDay, planDayListTypes, repPlanWeek, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { heldManagerSeats, managerChain, personKey, TERRITORY_TIER, type OrgIndex, type OrgSeat } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

/** A half of a field day. The same two words as a visit's list type, which is how a visit is matched. */
export type DoubleVisitHalf = PhoenixCrmListType;

export const DOUBLE_VISIT_HALVES: readonly DoubleVisitHalf[] = ["AM", "PM"];

/** The app role that plans double visits — an acting district manager holds it too. */
export const DOUBLE_VISIT_PLANNER_ROLE = "District Manager";

/** The organogram seats whose holder plans double visits: a district manager's, and an acting one's. */
export const DOUBLE_VISIT_PLANNER_TIERS: ReadonlySet<string> = new Set(["DM", "ACTING_DM"]);

export function isDoubleVisitHalf(value: unknown): value is DoubleVisitHalf {
  return value === "AM" || value === "PM";
}

// ── Who plans, and with whom ────────────────────────────────────────────────────────────────────

/** The district manager seats a person holds (DM or acting DM). Empty for everyone else. */
export function plannerSeats(org: OrgIndex, hrId: string | null | undefined): OrgSeat[] {
  return heldManagerSeats(org, hrId).filter((seat) => DOUBLE_VISIT_PLANNER_TIERS.has(seat.tier));
}

/**
 * Every person on a district manager seat, once each, with the first such seat — the people whose plans
 * the SFE Manager and the Super Admin choose between. `keep` narrows the seats (an SFE Manager reads the
 * open lines only).
 */
export function districtManagers(org: OrgIndex, keep: (seat: OrgSeat) => boolean = () => true): Array<{ hrId: string; seat: OrgSeat }> {
  const found = new Map<string, OrgSeat>();
  const seats = [...org.seats.values()]
    .filter((seat) => DOUBLE_VISIT_PLANNER_TIERS.has(seat.tier) && seat.occupantHrId && keep(seat))
    .sort((left, right) => left.seatId.localeCompare(right.seatId));
  for (const seat of seats) {
    const hrId = personKey(seat.occupantHrId);
    if (hrId && !found.has(hrId)) found.set(hrId, seat);
  }
  return [...found.entries()].map(([hrId, seat]) => ({ hrId, seat }));
}

/**
 * The rep seats a manager may plan to join, out of `seats` (the viewer's own reach): a territory with a
 * rep in it, where the manager is one of the territory's managers — the same chain a double visit is
 * entered against (scope.ts `resolveVisitParticipants`). Never a vacant seat (nobody to join), and
 * never a seat he holds himself: an acting district manager's own territory sits under his acting seat.
 */
export function doubleVisitTeam(org: OrgIndex, managerHrId: string | null | undefined, seats: ReadonlyArray<OrgSeat>): OrgSeat[] {
  const manager = personKey(managerHrId);
  if (!manager) return [];
  return seats.filter((seat) => {
    if (seat.tier !== TERRITORY_TIER) return false;
    const rep = personKey(seat.occupantHrId);
    if (!rep || rep === manager) return false;
    return managerChain(org, seat.seatId).some((member) => member.hrId === manager);
  });
}

// ── The weeks and the days ──────────────────────────────────────────────────────────────────────

/**
 * The weeks the plan opens on: last week and this week, to read against what happened, and the coming
 * week — the one he plans (calendar.ts `repPlanWeek`, the same week a rep plans).
 */
export function doubleVisitWeeks(cairoToday: string): string[] {
  const thisWeek = fieldWeekStart(cairoToday);
  return [addDaysIso(thisWeek, -7), thisWeek, repPlanWeek(cairoToday)];
}

/** The week the plan opens on when none is asked for: the coming one, the week he plans. */
export function defaultDoubleVisitWeek(cairoToday: string): string {
  return repPlanWeek(cairoToday);
}

export function isDoubleVisitWeek(value: unknown, cairoToday: string): value is string {
  return typeof value === "string" && doubleVisitWeeks(cairoToday).includes(value);
}

/** "Last week", "This week", "Coming week". */
export function doubleVisitWeekName(weekStart: string, cairoToday: string): string {
  const [last, current] = doubleVisitWeeks(cairoToday);
  if (weekStart === last) return "Last week";
  if (weekStart === current) return "This week";
  return "Coming week";
}

/** The halves a day can hold: none on a public holiday or a Friday, the morning on a Thursday. */
export function doubleVisitHalves(isoDay: string, holiday: string | null | undefined): DoubleVisitHalf[] {
  if (holiday) return [];
  return planDayListTypes(isoDay);
}

/**
 * A day the plan can still change: today or later, in this week or the coming one — never a day that
 * has passed (it is what the plan against actual reads), and never a week beyond the coming one.
 */
export function isDoubleVisitDayOpen(isoDay: string, cairoToday: string): boolean {
  if (!isIsoDay(isoDay) || isoDay < cairoToday) return false;
  if (planDayListTypes(isoDay).length === 0) return false;
  return fieldWeekStart(isoDay) <= repPlanWeek(cairoToday);
}

// ── One half-day saved ──────────────────────────────────────────────────────────────────────────

export type DoubleVisitSlotRefusalKind = "bad_input" | "not_field_time" | "passed" | "ahead" | "holiday" | "not_team";

export type ResolvedDoubleVisitSlot = {
  date: string;
  weekStart: string;
  half: DoubleVisitHalf;
  /** The rep seat he joins, or null to clear the half-day. */
  seat: OrgSeat | null;
  /** The rep seat the screen showed for this half-day, or null when it showed none. */
  expectedSeatId: string | null;
};

export type DoubleVisitSlotResult =
  | { ok: true; value: ResolvedDoubleVisitSlot }
  | { ok: false; kind: DoubleVisitSlotRefusalKind; error: string };

function seatIdOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * One half-day as the screen sent it, checked before the database is asked: a field day and a half it
 * holds, today or later in this week or the coming one, not a public holiday (clearing one is always
 * allowed), and a rep seat of the manager's own team.
 */
export function resolveDoubleVisitSlot(input: {
  date: unknown;
  half: unknown;
  seatId: unknown;
  expectedSeatId: unknown;
  cairoToday: string;
  holidays: ReadonlyMap<string, string>;
  team: ReadonlyArray<OrgSeat>;
}): DoubleVisitSlotResult {
  const date = input.date;
  const half = input.half;
  if (!isIsoDay(date)) return { ok: false, kind: "bad_input", error: "Choose the day. Reload the page." };
  if (!isDoubleVisitHalf(half)) return { ok: false, kind: "bad_input", error: "Choose AM or PM. Reload the page." };
  const weekday = weekdayOfIsoDay(date);
  if (weekday === 5) return { ok: false, kind: "not_field_time", error: "Friday is not a field day." };
  if (weekday === 4 && half === "PM") {
    return { ok: false, kind: "not_field_time", error: "Thursday is a morning: its double visit is AM only." };
  }
  if (date < input.cairoToday) {
    return { ok: false, kind: "passed", error: "This day has passed, so its double visits stay as they were planned. Reload the page." };
  }
  const weekStart = fieldWeekStart(date);
  if (weekStart > repPlanWeek(input.cairoToday)) {
    return { ok: false, kind: "ahead", error: "Double visits are planned for this week and the coming week. Reload the page." };
  }
  const expectedSeatId = seatIdOf(input.expectedSeatId);
  const seatId = seatIdOf(input.seatId);
  if (seatId === null) return { ok: true, value: { date, weekStart, half, seat: null, expectedSeatId } };
  const holiday = input.holidays.get(date);
  if (holiday) return { ok: false, kind: "holiday", error: `This day is a public holiday (${holiday}). No double visit is planned on it.` };
  const seat = input.team.find((entry) => entry.seatId === seatId);
  if (!seat) return { ok: false, kind: "not_team", error: "This rep is not in your team. Reload the page." };
  return { ok: true, value: { date, weekStart, half, seat, expectedSeatId } };
}

// ── The plan against what happened ──────────────────────────────────────────────────────────────

function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Whether a visit counts as this manager's double visit — the manager report's rule
 * (`phoenix_crm_report_manager_visits`): the manager of a double or chain visit, or the senior of a
 * chain visit — or, since 2026-10-27, anyone else a chain visit lists (`companionHrIds`: a third manager
 * up the line). His own single visit on the seat (no rep on it) is not a double visit.
 */
export function countsAsManagersDoubleVisit(
  visit: { kind: unknown; managerHrId: unknown; seniorHrId: unknown; companionHrIds?: unknown },
  managerHrId: string | null | undefined,
): boolean {
  const manager = personKey(managerHrId);
  if (!manager) return false;
  if (personKey(textOf(visit.seniorHrId)) === manager) return true;
  if (visit.kind === "chain" && Array.isArray(visit.companionHrIds) && visit.companionHrIds.some((value) => personKey(textOf(value)) === manager)) {
    return true;
  }
  return personKey(textOf(visit.managerHrId)) === manager && (visit.kind === "double" || visit.kind === "chain");
}

/** One half-day of one seat — how a planned slot and a visit meet. */
export function doubleVisitKey(seatId: string, date: string, half: DoubleVisitHalf): string {
  return `${seatId}|${date}|${half}`;
}

/** done; not_done once the day's visits have closed; open while they have not; ahead for a day to come. */
export type DoubleVisitOutcome = "done" | "not_done" | "open" | "ahead";

/**
 * A planned half-day against what happened. `visitDay` is the Cairo visit day (the date of now minus two
 * hours): a day is over for its visits only once the visit day has moved past it, so at 01:30 yesterday
 * is still open — the rep may still log what they did together.
 */
export function doubleVisitOutcome(input: { date: string; done: boolean; cairoToday: string; visitDay: string }): DoubleVisitOutcome {
  if (input.done) return "done";
  if (input.date < input.visitDay) return "not_done";
  if (input.date <= input.cairoToday) return "open";
  return "ahead";
}

/** A half-day as it is stored: the rep seat he planned to join, and the rep who held it then. */
export type DoubleVisitStoredSlot = { date: string; half: DoubleVisitHalf; seatId: string; repHrId: string | null };

export type DoubleVisitDayPlan = {
  date: string;
  /** The halves the day can hold: none on a public holiday, the morning on a Thursday. */
  halves: DoubleVisitHalf[];
  /** The public holiday this day is, by name, or null on a working day. */
  holiday: string | null;
  /** The viewer writes this plan and the day can still change. */
  editable: boolean;
  /**
   * Every half the day holds, and any half that already holds a planned rep (a day declared a holiday
   * after it was planned keeps its rep on screen, to be cleared).
   */
  slots: Array<{ half: DoubleVisitHalf; slot: DoubleVisitStoredSlot | null; outcome: DoubleVisitOutcome | null }>;
};

/** The week's days, each half-day with what was planned and, for a planned one, how it went. */
export function buildDoubleVisitDays(input: {
  weekStart: string;
  cairoToday: string;
  visitDay: string;
  holidays: ReadonlyMap<string, string>;
  slots: ReadonlyArray<DoubleVisitStoredSlot>;
  /** `doubleVisitKey`s of the half-days on which the manager was on a visit with the seat's rep. */
  doneKeys: ReadonlySet<string>;
  canWrite: boolean;
}): DoubleVisitDayPlan[] {
  return fieldWeekDays(input.weekStart).map((date) => {
    const holiday = input.holidays.get(date) ?? null;
    const halves = doubleVisitHalves(date, holiday);
    const stored = input.slots.filter((slot) => slot.date === date);
    const shown = DOUBLE_VISIT_HALVES.filter((half) => halves.includes(half) || stored.some((slot) => slot.half === half));
    return {
      date,
      halves,
      holiday,
      editable: input.canWrite && isDoubleVisitDayOpen(date, input.cairoToday),
      slots: shown.map((half) => {
        const slot = stored.find((entry) => entry.half === half) ?? null;
        const outcome = slot
          ? doubleVisitOutcome({
              date,
              done: input.doneKeys.has(doubleVisitKey(slot.seatId, date, half)),
              cairoToday: input.cairoToday,
              visitDay: input.visitDay,
            })
          : null;
        return { half, slot, outcome };
      }),
    };
  });
}

export type DoubleVisitSummary = { planned: number; done: number; notDone: number };

/** The week in three counts: planned half-days, the ones done, and the ones whose day closed without one. */
export function summarizeDoubleVisitWeek(days: ReadonlyArray<Pick<DoubleVisitDayPlan, "slots">>): DoubleVisitSummary {
  const summary: DoubleVisitSummary = { planned: 0, done: 0, notDone: 0 };
  for (const day of days) {
    for (const entry of day.slots) {
      if (!entry.slot) continue;
      summary.planned += 1;
      if (entry.outcome === "done") summary.done += 1;
      if (entry.outcome === "not_done") summary.notDone += 1;
    }
  }
  return summary;
}

/** "Planned 3 · done 2" — the week at a glance (owner, 2026-10-02). */
export function doubleVisitSummaryText(summary: Pick<DoubleVisitSummary, "planned" | "done">): string {
  return `Planned ${summary.planned} · done ${summary.done}`;
}
