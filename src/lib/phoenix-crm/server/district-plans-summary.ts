/**
 * District Managers' Plans — the figures the premium pass prints (owner, 9 Nov 2026: "eyeball every report in My
 * Team's Reports, premium polish, every single component"; "group reps by district manager"). The Regional Sales
 * Manager's screen, its panels and its Excel file all read these functions, so the three can never disagree.
 *
 * Pure: it reads the report `loadDistrictManagersPlans` built and nothing else — no database, no clock but the
 * report's own `cairoToday`. It lives under `server/` because it reads that loader's types; a pure Phoenix CRM rule
 * module may import nothing from `server/` (`phoenix-crm-boundary`).
 *
 *   - 🔴 A CHAIN VISIT IS INFORMATION, NEVER A WARNING (owner, 2026-10-24) — it has its own neutral list and is in
 *     no "to look at" reason, no tone and no count of problems.
 *   - 🔴 A WEEK SENT AND NOT DECIDED BEFORE ITS THURSDAY PASSED HAS ENDED (owner, 2026-11-08) — it reads
 *     `MANAGER_WEEK_ENDED_LABEL` and is counted as ended, never as waiting: nobody can approve it any more.
 *   - A vacant district manager seat is a seat, never a manager who did not send: it is in no "not sent" figure.
 *   - A draft is never shown. A week that is not sent prints only that it is not sent, and when it was due.
 *   - "Reps a manager is with" counts every manager kind's sent half-days on the rep (the loader's bookings), so a
 *     rep the Regional Sales Manager himself goes with is not listed as alone.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { cairoDate } from "@/lib/format/cairo-datetime";
import {
  MANAGER_PLAN_HALVES,
  MANAGER_SLOT_KINDS,
  MANAGER_WEEK_ENDED_LABEL,
  managerWeekPassed,
  type ManagerHalf,
  type ManagerSlotKind,
} from "@/lib/phoenix-crm/manager-plan-rules";
import type { RepWeekState } from "@/lib/phoenix-crm/server/manager-plans";
import type {
  DistrictManagersPlans,
  DistrictManagerWeek,
  DistrictPlanDay,
  DistrictPlanCustomer,
  DistrictPlanHalf,
  DistrictTeamRep,
} from "@/lib/phoenix-crm/server/manager-plan-bookings";

// ── The week's state ─────────────────────────────────────────────────────────────────────────────

/** Where one district manager's week stands, in the order the status bar reads them. */
export const DISTRICT_PLAN_STATES = ["approved", "waiting", "ended", "returned", "draft", "not_started", "vacant"] as const;
export type DistrictPlanState = (typeof DISTRICT_PLAN_STATES)[number];

export const DISTRICT_PLAN_STATE_LABEL: Record<DistrictPlanState, string> = {
  approved: "Approved",
  draft: "Not sent · a draft",
  ended: MANAGER_WEEK_ENDED_LABEL,
  not_started: "Not started",
  returned: "Returned for changes",
  vacant: "Seat is vacant",
  waiting: "Waiting for a decision",
};

/**
 * The flat swatch of each state — the bar, the dot beside a name and the left edge of its section. The vacant seat
 * is the lightest of all (owner, 2026-11-09: "if a seat a vacant color in light color").
 */
export const DISTRICT_PLAN_STATE_SWATCH: Record<DistrictPlanState, string> = {
  approved: "bg-emerald-700",
  draft: "bg-slate-400",
  ended: "bg-slate-600",
  not_started: "bg-slate-300",
  returned: "bg-orange-600",
  vacant: "bg-slate-100",
  waiting: "bg-amber-500",
};

export const DISTRICT_PLAN_STATE_EDGE: Record<DistrictPlanState, string> = {
  approved: "border-l-emerald-700",
  draft: "border-l-slate-400",
  ended: "border-l-slate-600",
  not_started: "border-l-slate-300",
  returned: "border-l-orange-600",
  vacant: "border-l-slate-200",
  waiting: "border-l-amber-500",
};

/** The week's state, from its own status — the ended rule first, so an ended week never reads as waiting. */
export function districtPlanState(week: Pick<DistrictManagerWeek, "managerHrId" | "status" | "endedUndecided">): DistrictPlanState {
  if (!week.managerHrId) return "vacant";
  if (week.endedUndecided) return "ended";
  if (week.status === "approved") return "approved";
  if (week.status === "submitted" || week.status === "first_approved") return "waiting";
  if (week.status === "returned") return "returned";
  if (week.status === "draft") return "draft";
  return "not_started";
}

/** Sent: waiting, approved, or ended undecided — the weeks whose half-days are shown. */
export function isDistrictPlanSentState(state: DistrictPlanState): boolean {
  return state === "approved" || state === "waiting" || state === "ended";
}

/** Not sent by a manager in the seat: a draft, a returned week, or none at all. A vacant seat is not one. */
export function isDistrictPlanUnsentState(state: DistrictPlanState): boolean {
  return state === "draft" || state === "returned" || state === "not_started";
}

// ── Days and halves ──────────────────────────────────────────────────────────────────────────────

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Sat 7" — a column head. Built from the ISO day in UTC, so no engine's zone or spacing can move it. */
export function districtPlanShortDay(iso: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  return `${WEEKDAY_SHORT[date.getUTCDay()]} ${date.getUTCDate()}`;
}

/** "7 Nov 2026" — a day in the sentences. */
export function districtPlanDayLabel(iso: string): string {
  return cairoDate(`${iso}T12:00:00Z`);
}

/** Saturday to Thursday: the six field days of the week, every one shown. */
export function districtPlanWorkingDays(weekStart: string): string[] {
  return Array.from({ length: 6 }, (_, offset) => addDaysIso(weekStart, offset));
}

/** The week's Friday — shown only when somebody planned something on it. */
export function districtPlanFriday(weekStart: string): string {
  return addDaysIso(weekStart, 6);
}

/** Whether the week has passed, is running, or is still ahead, from the report's own Cairo day. */
export type DistrictPlanWeekPosition = "past" | "current" | "ahead";

export function districtPlanWeekPosition(report: Pick<DistrictManagersPlans, "weekStart" | "cairoToday">): DistrictPlanWeekPosition {
  if (managerWeekPassed(report.weekStart, report.cairoToday)) return "past";
  if (report.cairoToday < report.weekStart) return "ahead";
  return "current";
}

/** The one line under the week's title that says where the week stands. */
export function districtPlanWeekPositionLine(report: Pick<DistrictManagersPlans, "weekStart" | "cairoToday">): string {
  const position = districtPlanWeekPosition(report);
  if (position === "past") return "This week has ended. A week still waiting can no longer be approved.";
  if (position === "ahead") return `This week is ahead. Today is ${districtPlanDayLabel(report.cairoToday)}.`;
  return `This week is running. Today is ${districtPlanDayLabel(report.cairoToday)}.`;
}

/** The half-day kinds, in the order the plan form offers them. */
export const DISTRICT_PLAN_KINDS: readonly ManagerSlotKind[] = MANAGER_SLOT_KINDS.map((entry) => entry.key);

/** The short words of each kind, for a count beside a bar. */
export const DISTRICT_PLAN_KIND_LABEL: Record<ManagerSlotKind, string> = {
  admin: "Admin",
  single_visit: "Single visits",
  with_area: "An area",
  with_dm: "With a district manager",
  with_rep: "With a rep",
  with_senior: "With a senior manager",
};

/** The flat swatch and edge of each kind — no kind is a warning colour. */
export const DISTRICT_PLAN_KIND_SWATCH: Record<ManagerSlotKind, string> = {
  admin: "bg-slate-500",
  single_visit: "bg-violet-700",
  with_area: "bg-teal-700",
  with_dm: "bg-indigo-700",
  with_rep: "bg-sky-700",
  with_senior: "bg-indigo-700",
};

export const DISTRICT_PLAN_KIND_EDGE: Record<ManagerSlotKind, string> = {
  admin: "border-l-slate-400",
  single_visit: "border-l-violet-700",
  with_area: "border-l-teal-700",
  with_dm: "border-l-indigo-700",
  with_rep: "border-l-sky-700",
  with_senior: "border-l-indigo-700",
};

function emptyKindCounts(): Record<ManagerSlotKind, number> {
  return { admin: 0, single_visit: 0, with_area: 0, with_dm: 0, with_rep: 0, with_senior: 0 };
}

/** What the rep's own week says beside a half with him, in words. */
export const DISTRICT_PLAN_REP_WEEK_LABEL: Record<RepWeekState, string> = {
  no_plan: "No plan",
  not_sent: "Not sent",
  old_crm: "Old CRM plan",
  sent: "Sent",
};

/** The rep's own week is not there to plan beside: not sent, or no plan at all. The old CRM's plan is a plan. */
export function isRepWeekMissing(state: RepWeekState | null): boolean {
  return state === "not_sent" || state === "no_plan";
}

// ── One district manager's week ──────────────────────────────────────────────────────────────────

export type DistrictPlanWeekFigures = {
  state: DistrictPlanState;
  sent: boolean;
  /** Every planned half-day of the sent week, Friday included. */
  halves: number;
  byKind: Record<ManagerSlotKind, number>;
  /** Saturday to Thursday half-days with nothing planned and him not on leave — a sent week only. */
  openHalves: number;
  /** His own leave days, Saturday to Thursday. */
  leaveDays: number;
  /** The distinct reps he goes with. */
  repsWith: number;
  /** The reps in his team, vacant seats left out. */
  repsInTeam: number;
  vacantSeats: number;
  /** The customers he ticked across the week, a customer ticked twice counted twice. */
  customers: number;
  goneCustomers: number;
  /** Half-days with a rep where another manager is with the same rep that day. Information only. */
  chainVisitHalves: number;
  /** Half-days with a rep on approved leave that day. */
  repOnLeaveHalves: number;
  /** Half-days with a rep whose own week is not sent or has no plan (and who is not on leave). */
  repWeekMissingHalves: number;
  late: boolean;
};

/** Every half of the week, in day then AM, PM order. */
export function districtPlanHalves(week: Pick<DistrictManagerWeek, "days">): Array<{ day: DistrictPlanDay; half: DistrictPlanHalf }> {
  return week.days.flatMap((day) => day.halves.map((half) => ({ day, half })));
}

export function districtPlanWeekFigures(week: DistrictManagerWeek, weekStart: string): DistrictPlanWeekFigures {
  const state = districtPlanState(week);
  const sent = isDistrictPlanSentState(state);
  const byKind = emptyKindCounts();
  const repsWith = new Set<string>();
  let customers = 0;
  let goneCustomers = 0;
  let chainVisitHalves = 0;
  let repOnLeaveHalves = 0;
  let repWeekMissingHalves = 0;
  const all = sent ? districtPlanHalves(week) : [];
  for (const { half } of all) {
    byKind[half.kind] += 1;
    customers += half.customers.length;
    goneCustomers += half.goneCustomers;
    if (half.kind !== "with_rep") continue;
    if (half.repSeatId) repsWith.add(half.repSeatId);
    if (half.chainVisits.length > 0) chainVisitHalves += 1;
    if (half.repOnLeave) repOnLeaveHalves += 1;
    else if (isRepWeekMissing(half.repWeekState)) repWeekMissingHalves += 1;
  }
  const working = new Set(districtPlanWorkingDays(weekStart));
  const leave = new Set(week.managerLeaveDays.filter((date) => working.has(date)));
  let openHalves = 0;
  if (sent) {
    for (const date of working) {
      if (leave.has(date)) continue;
      const planned = week.days.find((day) => day.date === date)?.halves.length ?? 0;
      openHalves += Math.max(0, MANAGER_PLAN_HALVES.length - planned);
    }
  }
  const occupied = week.reps.filter((rep) => !rep.vacant);
  return {
    byKind,
    chainVisitHalves,
    customers,
    goneCustomers,
    halves: all.length,
    late: week.submittedLate,
    leaveDays: leave.size,
    openHalves,
    repOnLeaveHalves,
    repWeekMissingHalves,
    repsInTeam: occupied.length,
    repsWith: repsWith.size,
    sent,
    state,
    vacantSeats: week.reps.length - occupied.length,
  };
}

/** "6 with a rep · 3 admin · 1 single visit" — the kinds he planned, the empty ones left out. */
export function districtPlanKindsLine(byKind: Record<ManagerSlotKind, number>): string {
  const parts = DISTRICT_PLAN_KINDS.filter((kind) => byKind[kind] > 0).map((kind) => `${byKind[kind]} ${DISTRICT_PLAN_KIND_LABEL[kind].toLowerCase()}`);
  return parts.length ? parts.join(" · ") : "Nothing planned";
}

/** "1 rep" / "3 reps". */
export function districtRepsWord(count: number): string {
  return `${count} ${count === 1 ? "rep" : "reps"}`;
}

/** "1 half-day" / "4 half-days". */
export function halfDaysWord(count: number): string {
  return `${count} ${count === 1 ? "half-day" : "half-days"}`;
}

/** "1 customer" / "12 customers". */
export function customersWord(count: number): string {
  return `${count} ${count === 1 ? "customer" : "customers"}`;
}

/** The sentence under a manager's heading — when the week was sent, whether late, and the last decision. */
export function districtPlanSentLine(
  week: Pick<DistrictManagerWeek, "submittedAt" | "submittedLate" | "dueOn" | "decidedAt" | "status" | "endedUndecided" | "managerHrId">,
  format: (iso: string) => string,
): string {
  if (!week.managerHrId) return "Nobody is in this district manager seat.";
  const due = week.dueOn ? `due ${districtPlanDayLabel(week.dueOn)}` : null;
  if (week.status !== "submitted" && week.status !== "first_approved" && week.status !== "approved") {
    if (week.status === "returned") return `Returned for changes and not sent again${due ? ` · ${due}` : ""}.`;
    return `Not sent yet${due ? ` · ${due}` : ""}.`;
  }
  const parts: string[] = [];
  parts.push(week.submittedAt ? `Sent ${format(week.submittedAt)}` : "Sent");
  if (week.submittedLate) parts.push(due ? `late, ${due}` : "late");
  if (week.status === "approved" && week.decidedAt) parts.push(`approved ${format(week.decidedAt)}`);
  if (week.endedUndecided) parts.push("the week ended before anyone approved it");
  return `${parts.join(" · ")}.`;
}

// ── The whole team ───────────────────────────────────────────────────────────────────────────────

export type DistrictPlansTeamTotals = {
  /** District manager seats with somebody in them. */
  managers: number;
  vacantManagerSeats: number;
  byState: Record<DistrictPlanState, number>;
  sent: number;
  /** Not sent by a manager in the seat — a draft, a returned week or none. */
  notSent: number;
  late: number;
  halves: number;
  byKind: Record<ManagerSlotKind, number>;
  openHalves: number;
  /** Reps in the team, vacant seats left out. */
  reps: number;
  /** Reps at least one manager is with this week, of any kind. */
  repsWithAManager: number;
  vacantRepSeats: number;
  customers: number;
  goneCustomers: number;
  chainVisitHalves: number;
};

export function districtPlansTeamTotals(report: Pick<DistrictManagersPlans, "weeks" | "weekStart">): DistrictPlansTeamTotals {
  const byState = Object.fromEntries(DISTRICT_PLAN_STATES.map((state) => [state, 0])) as Record<DistrictPlanState, number>;
  const byKind = emptyKindCounts();
  let halves = 0;
  let openHalves = 0;
  let late = 0;
  let reps = 0;
  let repsWithAManager = 0;
  let vacantRepSeats = 0;
  let customers = 0;
  let goneCustomers = 0;
  let chainVisitHalves = 0;
  for (const week of report.weeks) {
    const figures = districtPlanWeekFigures(week, report.weekStart);
    byState[figures.state] += 1;
    for (const kind of DISTRICT_PLAN_KINDS) byKind[kind] += figures.byKind[kind];
    halves += figures.halves;
    openHalves += figures.openHalves;
    if (figures.sent && figures.late) late += 1;
    customers += figures.customers;
    goneCustomers += figures.goneCustomers;
    chainVisitHalves += figures.chainVisitHalves;
    for (const rep of week.reps) {
      if (rep.vacant) {
        vacantRepSeats += 1;
        continue;
      }
      reps += 1;
      if (rep.managers.length > 0) repsWithAManager += 1;
    }
  }
  const sent = byState.approved + byState.waiting + byState.ended;
  return {
    byKind,
    byState,
    chainVisitHalves,
    customers,
    goneCustomers,
    halves,
    late,
    managers: report.weeks.length - byState.vacant,
    notSent: byState.draft + byState.returned + byState.not_started,
    openHalves,
    reps,
    repsWithAManager,
    sent,
    vacantManagerSeats: byState.vacant,
    vacantRepSeats,
  };
}

/** One bar segment: a state or a kind, its count and its share of the bar's whole, in whole per cent. */
export type DistrictPlanBarPart<K extends string> = { key: K; label: string; count: number; percent: number; swatch: string };

/**
 * Shares that add up to 100 exactly (largest remainder), so a bar never ends short or overflows. A zero count is
 * left out; an empty whole is an empty bar, never a 0% one.
 */
export function districtPlanShares<K extends string>(parts: ReadonlyArray<{ key: K; label: string; count: number; swatch: string }>): DistrictPlanBarPart<K>[] {
  const whole = parts.reduce((sum, part) => sum + part.count, 0);
  if (whole === 0) return [];
  const raw = parts.filter((part) => part.count > 0).map((part) => ({ ...part, exact: (part.count * 100) / whole }));
  const floored = raw.map((part) => ({ ...part, percent: Math.floor(part.exact) }));
  let left = 100 - floored.reduce((sum, part) => sum + part.percent, 0);
  const order = [...floored].sort((a, b) => b.exact - b.percent - (a.exact - a.percent));
  for (const part of order) {
    if (left <= 0) break;
    part.percent += 1;
    left -= 1;
  }
  return floored.map(({ count, key, label, percent, swatch }) => ({ count, key, label, percent, swatch }));
}

/** The status bar: every seat, by where its week stands. Adds up to the seats on the page. */
export function districtPlanStateBar(totals: Pick<DistrictPlansTeamTotals, "byState">): DistrictPlanBarPart<DistrictPlanState>[] {
  return districtPlanShares(
    DISTRICT_PLAN_STATES.map((state) => ({ count: totals.byState[state], key: state, label: DISTRICT_PLAN_STATE_LABEL[state], swatch: DISTRICT_PLAN_STATE_SWATCH[state] })),
  );
}

/** The kinds bar: every planned half-day of the sent weeks, by kind. Adds up to the half-days tile. */
export function districtPlanKindBar(totals: Pick<DistrictPlansTeamTotals, "byKind">): DistrictPlanBarPart<ManagerSlotKind>[] {
  return districtPlanShares(
    DISTRICT_PLAN_KINDS.map((kind) => ({ count: totals.byKind[kind], key: kind, label: DISTRICT_PLAN_KIND_LABEL[kind], swatch: DISTRICT_PLAN_KIND_SWATCH[kind] })),
  );
}

/** The one sentence under the bars. */
export function districtPlansTeamLine(totals: DistrictPlansTeamTotals): string {
  if (totals.managers === 0) return "No district manager seat under you has somebody in it.";
  const parts = [`${totals.sent} of ${totals.managers} district managers sent their week`];
  if (totals.byState.approved > 0) parts.push(`${totals.byState.approved} approved`);
  if (totals.byState.waiting > 0) parts.push(`${totals.byState.waiting} waiting for a decision`);
  if (totals.byState.ended > 0) parts.push(`${totals.byState.ended} ended undecided`);
  if (totals.late > 0) parts.push(`${totals.late} sent late`);
  return `${parts.join(" · ")}.`;
}

// ── The week at a glance ─────────────────────────────────────────────────────────────────────────

export type DistrictPlanGridCell =
  | { state: "planned"; kind: ManagerSlotKind; text: string; repOnLeave: boolean; chainVisit: boolean }
  | { state: "leave" }
  | { state: "open" }
  | { state: "unsent" };

export type DistrictPlanGridRow = {
  week: DistrictManagerWeek;
  state: DistrictPlanState;
  /** One cell per day and half, in the grid's own day order. */
  cells: Array<{ date: string; half: ManagerHalf; cell: DistrictPlanGridCell }>;
};

export type DistrictPlanGrid = { days: string[]; rows: DistrictPlanGridRow[] };

/** The few words a grid cell carries: the rep's name for a half with a rep, otherwise the plan's own words. */
export function districtPlanCellText(half: Pick<DistrictPlanHalf, "kind" | "repName" | "text">): string {
  if (half.kind === "with_rep") return half.repName ?? half.text;
  return half.text;
}

/**
 * The week at a glance: one row per district manager seat, one column per day, AM over PM. Saturday to Thursday are
 * always there; Friday only when a sent week planned it. A week not sent fills its row with "Not sent", never with
 * its draft; a vacant seat is left out (it has no week to show).
 */
export function districtPlansGrid(report: Pick<DistrictManagersPlans, "weeks" | "weekStart">): DistrictPlanGrid {
  const friday = districtPlanFriday(report.weekStart);
  const rows = report.weeks.filter((week) => week.managerHrId);
  const fridayPlanned = rows.some((week) => isDistrictPlanSentState(districtPlanState(week)) && week.days.some((day) => day.date === friday && day.halves.length > 0));
  const days = [...districtPlanWorkingDays(report.weekStart), ...(fridayPlanned ? [friday] : [])];
  return {
    days,
    rows: rows.map((week) => {
      const state = districtPlanState(week);
      const sent = isDistrictPlanSentState(state);
      const leave = new Set(week.managerLeaveDays);
      return {
        cells: days.flatMap((date) =>
          MANAGER_PLAN_HALVES.map((half) => {
            if (!sent) return { cell: { state: "unsent" } as DistrictPlanGridCell, date, half };
            const planned = week.days.find((day) => day.date === date)?.halves.find((entry) => entry.half === half);
            if (planned) {
              return {
                cell: { chainVisit: planned.chainVisits.length > 0, kind: planned.kind, repOnLeave: planned.repOnLeave, state: "planned", text: districtPlanCellText(planned) } as DistrictPlanGridCell,
                date,
                half,
              };
            }
            return { cell: (leave.has(date) ? { state: "leave" } : { state: "open" }) as DistrictPlanGridCell, date, half };
          }),
        ),
        state,
        week,
      };
    }),
  };
}

// ── To look at ───────────────────────────────────────────────────────────────────────────────────

/** Why a week is on the "to look at" list, in the order the list reads them. A chain visit is never one. */
export const DISTRICT_PLAN_ATTENTION = ["not_sent", "ended", "late", "rep_on_leave", "rep_week_missing", "gone_customers"] as const;
export type DistrictPlanAttentionReason = (typeof DISTRICT_PLAN_ATTENTION)[number];

export const DISTRICT_PLAN_ATTENTION_LABEL: Record<DistrictPlanAttentionReason, string> = {
  ended: "Ended undecided",
  gone_customers: "Customers no longer on file",
  late: "Sent late",
  not_sent: "Not sent",
  rep_on_leave: "With a rep on leave",
  rep_week_missing: "Rep's own week missing",
};

export type DistrictPlanAttentionItem = {
  reason: DistrictPlanAttentionReason;
  week: DistrictManagerWeek;
  /** One plain sentence, never an accusation. */
  line: string;
};

function halfWhen(day: DistrictPlanDay, half: DistrictPlanHalf): string {
  return `${districtPlanShortDay(day.date)} ${half.half}`;
}

/**
 * The weeks worth a second look, each reason once per week with every half it names in one line. A vacant seat is
 * never on it; a chain visit is never on it (owner, 2026-10-24).
 */
export function districtPlansAttention(report: Pick<DistrictManagersPlans, "weeks">): DistrictPlanAttentionItem[] {
  const items: DistrictPlanAttentionItem[] = [];
  for (const week of report.weeks) {
    const state = districtPlanState(week);
    if (state === "vacant") continue;
    if (isDistrictPlanUnsentState(state)) {
      const due = week.dueOn ? `, due ${districtPlanDayLabel(week.dueOn)}` : "";
      items.push({
        line: state === "returned" ? `Returned for changes and not sent again${due}.` : `The week is not sent yet${due}.`,
        reason: "not_sent",
        week,
      });
      continue;
    }
    if (state === "ended") items.push({ line: "Sent, but the week ended before anyone approved it. It can no longer be approved.", reason: "ended", week });
    if (week.submittedLate) {
      const due = week.dueOn ? ` It was due ${districtPlanDayLabel(week.dueOn)}.` : "";
      items.push({ line: `Sent after it was due.${due}`, reason: "late", week });
    }
    const halves = districtPlanHalves(week);
    const onLeave = halves.filter(({ half }) => half.kind === "with_rep" && half.repOnLeave);
    if (onLeave.length > 0) {
      items.push({
        line: `${onLeave.map(({ day, half }) => `${halfWhen(day, half)} with ${half.repName ?? "a rep"}`).join(" · ")} — the rep is on approved leave that day.`,
        reason: "rep_on_leave",
        week,
      });
    }
    const missing = halves.filter(({ half }) => half.kind === "with_rep" && !half.repOnLeave && isRepWeekMissing(half.repWeekState));
    if (missing.length > 0) {
      items.push({
        line: `${missing
          .map(({ day, half }) => `${halfWhen(day, half)} with ${half.repName ?? "a rep"} (${DISTRICT_PLAN_REP_WEEK_LABEL[half.repWeekState ?? "no_plan"].toLowerCase()})`)
          .join(" · ")} — the rep's own week is not there to plan beside.`,
        reason: "rep_week_missing",
        week,
      });
    }
    const gone = halves.filter(({ half }) => half.goneCustomers > 0);
    if (gone.length > 0) {
      const count = gone.reduce((sum, { half }) => sum + half.goneCustomers, 0);
      items.push({
        line: `${customersWord(count)} ticked ${count === 1 ? "is" : "are"} no longer on file: ${gone.map(({ day, half }) => halfWhen(day, half)).join(" · ")}.`,
        reason: "gone_customers",
        week,
      });
    }
  }
  const order = (reason: DistrictPlanAttentionReason) => DISTRICT_PLAN_ATTENTION.indexOf(reason);
  return items.sort((left, right) => order(left.reason) - order(right.reason) || left.week.managerName.localeCompare(right.week.managerName));
}

/** How many items each reason holds — the counts beside the list's key. */
export function districtPlanAttentionCounts(items: readonly DistrictPlanAttentionItem[]): Record<DistrictPlanAttentionReason, number> {
  const counts = Object.fromEntries(DISTRICT_PLAN_ATTENTION.map((reason) => [reason, 0])) as Record<DistrictPlanAttentionReason, number>;
  for (const item of items) counts[item.reason] += 1;
  return counts;
}

// ── The reps ─────────────────────────────────────────────────────────────────────────────────────

export type DistrictRepAlone = { week: DistrictManagerWeek; reps: DistrictTeamRep[] };

/**
 * The reps no manager of any kind is with this week, team by team — the vacant seats left out. A rep on leave all
 * six field days is left out too: nobody could be with them.
 */
export function districtPlansRepsAlone(report: Pick<DistrictManagersPlans, "weeks" | "weekStart">): DistrictRepAlone[] {
  const working = districtPlanWorkingDays(report.weekStart);
  return report.weeks
    .map((week) => ({
      reps: week.reps.filter((rep) => !rep.vacant && rep.managers.length === 0 && !working.every((date) => rep.leaveDays.includes(date))),
      week,
    }))
    .filter((entry) => entry.reps.length > 0);
}

/** "Away 2 days" / "Away all week" — a rep's leave in a few words; null with none. */
export function districtRepLeaveLine(rep: Pick<DistrictTeamRep, "leaveDays">, weekStart: string): string | null {
  const working = new Set(districtPlanWorkingDays(weekStart));
  const days = rep.leaveDays.filter((date) => working.has(date));
  if (days.length === 0) return null;
  if (days.length === working.size) return "On leave all week";
  return `On leave ${days.map(districtPlanShortDay).join(", ")}`;
}

/** The managers with a rep this week, in words: "With Sahar El Gallad, Hany Saad" or "No manager this week". */
export function districtRepManagersLine(rep: Pick<DistrictTeamRep, "managers" | "vacant">): string {
  if (rep.vacant) return "Seat is vacant";
  return rep.managers.length ? `With ${rep.managers.join(", ")}` : "No manager this week";
}

// ── Chain visits — neutral ───────────────────────────────────────────────────────────────────────

export type DistrictPlanChainVisit = { week: DistrictManagerWeek; date: string; half: ManagerHalf; repName: string; lines: string[] };

/** Every half-day with a rep where another manager is with the same rep that day. Never a warning. */
export function districtPlansChainVisits(report: Pick<DistrictManagersPlans, "weeks">): DistrictPlanChainVisit[] {
  const out: DistrictPlanChainVisit[] = [];
  for (const week of report.weeks) {
    if (!isDistrictPlanSentState(districtPlanState(week))) continue;
    for (const { day, half } of districtPlanHalves(week)) {
      if (half.kind !== "with_rep" || half.chainVisits.length === 0) continue;
      out.push({ date: day.date, half: half.half, lines: half.chainVisits, repName: half.repName ?? "a rep", week });
    }
  }
  return out.sort((left, right) => left.date.localeCompare(right.date) || left.half.localeCompare(right.half) || left.week.managerName.localeCompare(right.week.managerName));
}

// ── The filter ───────────────────────────────────────────────────────────────────────────────────

/** Which district managers the screen lists. The tiles, bars and grid are always the whole team's. */
export const DISTRICT_PLAN_SHOW = ["all", "sent", "waiting", "not_sent"] as const;
export type DistrictPlanShow = (typeof DISTRICT_PLAN_SHOW)[number];

export const DISTRICT_PLAN_SHOW_LABEL: Record<DistrictPlanShow, string> = {
  all: "Every seat",
  not_sent: "Not sent",
  sent: "Sent",
  waiting: "Waiting for a decision",
};

/** The `show` search parameter, read strictly — anything else is every seat. */
export function parseDistrictPlanShow(value: unknown): DistrictPlanShow {
  const text = Array.isArray(value) ? value[0] : value;
  return (DISTRICT_PLAN_SHOW as readonly string[]).includes(String(text ?? "")) ? (text as DistrictPlanShow) : "all";
}

/** Narrows the weeks the screen lists. A vacant seat is listed under "Every seat" only. */
export function filterDistrictPlanWeeks(weeks: readonly DistrictManagerWeek[], show: DistrictPlanShow): DistrictManagerWeek[] {
  return weeks.filter((week) => {
    const state = districtPlanState(week);
    if (show === "sent") return isDistrictPlanSentState(state);
    if (show === "waiting") return state === "waiting";
    if (show === "not_sent") return isDistrictPlanUnsentState(state);
    return true;
  });
}

/** How many seats each filter lists — printed on the filter itself, so a click never lands on an empty page by surprise. */
export function districtPlanShowCounts(weeks: readonly DistrictManagerWeek[]): Record<DistrictPlanShow, number> {
  return {
    all: filterDistrictPlanWeeks(weeks, "all").length,
    not_sent: filterDistrictPlanWeeks(weeks, "not_sent").length,
    sent: filterDistrictPlanWeeks(weeks, "sent").length,
    waiting: filterDistrictPlanWeeks(weeks, "waiting").length,
  };
}

/** The screen's own address — a fixed path, only the two known keys. `week` is left out for the current week. */
export const DISTRICT_PLANS_PATH = "/employee-portals/district-manager-plans";

/** The Super Admin's twin in the admin shell, over the whole company (owner, 2026-11-11). */
export const DISTRICT_PLANS_ADMIN_PATH = "/admin/field-crm/district-manager-plans";

export function districtPlansHref(week: string | null, show: DistrictPlanShow = "all", base: string = DISTRICT_PLANS_PATH): string {
  const params = new URLSearchParams();
  if (week) params.set("week", week);
  if (show !== "all") params.set("show", show);
  const query = params.toString();
  return `${base}${query ? `?${query}` : ""}`;
}

/** The anchor a manager's section carries, so a name on a panel jumps to it. */
export function districtPlanAnchor(week: Pick<DistrictManagerWeek, "districtSeatId">): string {
  const slug = week.districtSeatId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `dm-${slug || "seat"}`;
}

/** The seats the screen lists under the filter — a name links to its section only when that section is on the page. */
export function districtPlanListedSeats(weeks: readonly DistrictManagerWeek[], show: DistrictPlanShow): Set<string> {
  return new Set(filterDistrictPlanWeeks(weeks, show).map((week) => week.districtSeatId));
}

// ── Whom they will visit ─────────────────────────────────────────────────────────────────────────

/**
 * The customers the district managers ticked, read closely (owner, 2026-11-08, Dr. Hany Saad's sixth need: "know who
 * he goes with and whom he will visit"). A customer ticked on two half-days is ticked twice but is ONE customer: the
 * grades and specialities count customers, never ticks. A customer no longer on file is counted and named as such.
 */
export const DISTRICT_CUSTOMER_GRADE_KEYS = ["A", "B", "C", "none"] as const;
export type DistrictCustomerGradeKey = (typeof DISTRICT_CUSTOMER_GRADE_KEYS)[number];

export const DISTRICT_CUSTOMER_GRADE_LABEL: Record<DistrictCustomerGradeKey, string> = { A: "A", B: "B", C: "C", none: "No grade" };

/** The words for a customer with no speciality on file. */
export const DISTRICT_NO_SPECIALITY = "No speciality";

export type DistrictCustomerMix = {
  /** Every tick across the sent weeks read — one customer on two half-days is two ticks. */
  ticked: number;
  /** The different customers behind those ticks. */
  distinct: number;
  byGrade: Record<DistrictCustomerGradeKey, number>;
  /** Different customers no longer on file. */
  gone: number;
  /** Different customers from a manager's own list. */
  ownList: number;
  /** Different customers per speciality, most first, then by name. */
  specialities: Array<{ speciality: string; count: number }>;
  /** The customers ticked on more than one half-day, most first. */
  repeated: Array<{ name: string; times: number }>;
};

function customerKey(customer: Pick<DistrictPlanCustomer, "name" | "speciality">): string {
  return `${customer.name.trim().toLowerCase()}|${(customer.speciality ?? "").trim().toLowerCase()}`;
}

/** The mix of the customers ticked on these weeks' sent half-days. A week not sent adds nothing. */
export function districtCustomerMix(weeks: readonly DistrictManagerWeek[]): DistrictCustomerMix {
  const byKey = new Map<string, { customer: DistrictPlanCustomer; times: number }>();
  let ticked = 0;
  for (const week of weeks) {
    if (!isDistrictPlanSentState(districtPlanState(week))) continue;
    for (const { half } of districtPlanHalves(week)) {
      for (const customer of half.customerDetails) {
        ticked += 1;
        const key = customerKey(customer);
        const held = byKey.get(key);
        if (held) held.times += 1;
        else byKey.set(key, { customer, times: 1 });
      }
    }
  }
  const byGrade: Record<DistrictCustomerGradeKey, number> = { A: 0, B: 0, C: 0, none: 0 };
  const specialityCounts = new Map<string, number>();
  let gone = 0;
  let ownList = 0;
  for (const { customer } of byKey.values()) {
    byGrade[customer.grade ?? "none"] += 1;
    if (customer.gone) gone += 1;
    if (customer.ownList) ownList += 1;
    const speciality = customer.speciality?.trim() || DISTRICT_NO_SPECIALITY;
    specialityCounts.set(speciality, (specialityCounts.get(speciality) ?? 0) + 1);
  }
  const specialities = [...specialityCounts]
    .map(([speciality, count]) => ({ count, speciality }))
    .sort((left, right) => right.count - left.count || Number(left.speciality === DISTRICT_NO_SPECIALITY) - Number(right.speciality === DISTRICT_NO_SPECIALITY) || left.speciality.localeCompare(right.speciality));
  const repeated = [...byKey.values()]
    .filter((entry) => entry.times > 1)
    .map((entry) => ({ name: entry.customer.name, times: entry.times }))
    .sort((left, right) => right.times - left.times || left.name.localeCompare(right.name));
  return { byGrade, distinct: byKey.size, gone, ownList, repeated, specialities, ticked };
}

/** "4 ticks · 3 different customers" — or "No customer ticked". */
export function districtCustomerCountLine(mix: Pick<DistrictCustomerMix, "ticked" | "distinct">): string {
  if (mix.ticked === 0) return "No customer ticked";
  return `${mix.ticked} ${mix.ticked === 1 ? "tick" : "ticks"} · ${mix.distinct} different ${mix.distinct === 1 ? "customer" : "customers"}`;
}

/** "1 A · 1 B · 1 with no grade" — the grades with customers, in order; null when nobody was ticked. */
export function districtCustomerGradeLine(mix: Pick<DistrictCustomerMix, "byGrade" | "distinct">): string | null {
  if (mix.distinct === 0) return null;
  return DISTRICT_CUSTOMER_GRADE_KEYS.filter((key) => mix.byGrade[key] > 0)
    .map((key) => (key === "none" ? `${mix.byGrade[key]} with no grade` : `${mix.byGrade[key]} ${key}`))
    .join(" · ");
}

/** "Paediatrics 2 · General Practice 1" — the first few specialities; null when nobody was ticked. */
export function districtCustomerSpecialityLine(mix: Pick<DistrictCustomerMix, "specialities">, limit = 3): string | null {
  if (mix.specialities.length === 0) return null;
  const shown = mix.specialities.slice(0, limit).map((entry) => `${entry.speciality} ${entry.count}`);
  const more = mix.specialities.length - limit;
  return more > 0 ? `${shown.join(" · ")} · ${more} more ${more === 1 ? "speciality" : "specialities"}` : shown.join(" · ");
}

/** "Dr. Mona Saleh ×2" — the customers ticked more than once; null with none. */
export function districtCustomerRepeatedLine(mix: Pick<DistrictCustomerMix, "repeated">): string | null {
  if (mix.repeated.length === 0) return null;
  return `Ticked more than once: ${mix.repeated.map((entry) => `${entry.name} ×${entry.times}`).join(" · ")}`;
}

/** The share of the graded customers that are A, in whole per cent; null with no graded customer. */
export function districtCustomerAShare(mix: Pick<DistrictCustomerMix, "byGrade">): number | null {
  const graded = mix.byGrade.A + mix.byGrade.B + mix.byGrade.C;
  return graded === 0 ? null : Math.round((mix.byGrade.A * 100) / graded);
}

/** One row per district manager with a sent week, and the whole team's mix. */
export function districtPlansCustomerRows(report: Pick<DistrictManagersPlans, "weeks">): { rows: Array<{ week: DistrictManagerWeek; mix: DistrictCustomerMix }>; team: DistrictCustomerMix } {
  const sent = report.weeks.filter((week) => isDistrictPlanSentState(districtPlanState(week)));
  return { rows: sent.map((week) => ({ mix: districtCustomerMix([week]), week })), team: districtCustomerMix(sent) };
}

/** Every tick of the sent weeks, one line each — the Excel file's Customers sheet. */
export type DistrictCustomerTick = { week: DistrictManagerWeek; day: DistrictPlanDay; half: DistrictPlanHalf; customer: DistrictPlanCustomer };

export function districtPlansCustomerTicks(report: Pick<DistrictManagersPlans, "weeks">): DistrictCustomerTick[] {
  return report.weeks.flatMap((week) =>
    isDistrictPlanSentState(districtPlanState(week))
      ? districtPlanHalves(week).flatMap(({ day, half }) => half.customerDetails.map((customer) => ({ customer, day, half, week })))
      : [],
  );
}
