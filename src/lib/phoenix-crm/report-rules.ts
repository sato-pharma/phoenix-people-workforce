/**
 * Phoenix CRM — report periods and figures, with no I/O.
 *
 * Owner, 2026-09-16: the first report shows visits per rep per day (AM and PM apart), plan against
 * actual, coverage and frequency, and double visits per manager.
 *
 *   - AM and PM are never added together or averaged into one figure (standing rule: the call rate is
 *     never averaged). Every total here is kept per list type.
 *   - Frequency counts customers EXACTLY on their grade's number; over is a deviation reported beside
 *     under, never a success (coverage.ts).
 *   - A day-by-day report reads at most a month at a time.
 */

import { isIsoDay, isMonthKey, monthEndOf, monthStartOf } from "@/lib/phoenix-crm/calendar";
import { sharePercent } from "@/lib/phoenix-crm/coverage";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

export const REPORT_MAX_DAYS = 31;

export type ReportRuleResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type ByList<T> = Record<PhoenixCrmListType, T>;

type Row = Record<string, unknown>;

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function listTypeOf(value: unknown): PhoenixCrmListType {
  return value === "AM" ? "AM" : "PM";
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ── Periods ─────────────────────────────────────────────────────────────────────────────────────

export type ReportPeriod = { from: string; to: string };

/** Days from `from` to `to`, both counted. */
export function daysInPeriod(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function blank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** A day-by-day period: the 1st of the month to today unless chosen, never past today, at most a month. */
export function resolveReportPeriod(input: { from: unknown; to: unknown; cairoToday: string }): ReportRuleResult<ReportPeriod> {
  const today = input.cairoToday;
  const toRaw = blank(input.to) ? today : input.to;
  if (!isIsoDay(toRaw)) return { ok: false, error: "Choose a valid last day." };
  const to = toRaw > today ? today : toRaw;
  const fromRaw = blank(input.from) ? monthStartOf(to) : input.from;
  if (!isIsoDay(fromRaw)) return { ok: false, error: "Choose a valid first day." };
  if (fromRaw > to) return { ok: false, error: "The first day is after the last day." };
  if (daysInPeriod(fromRaw, to) > REPORT_MAX_DAYS) return { ok: false, error: `Choose at most ${REPORT_MAX_DAYS} days.` };
  return { ok: true, value: { from: fromRaw, to } };
}

export type ReportMonth = { month: string; monthStart: string; monthEnd: string; inProgress: boolean };

/** A coverage month: this month unless chosen; a month that has not started is refused. */
export function resolveReportMonth(input: { month: unknown; cairoToday: string }): ReportRuleResult<ReportMonth> {
  const current = input.cairoToday.slice(0, 7);
  const month = blank(input.month) ? current : input.month;
  if (!isMonthKey(month)) return { ok: false, error: "Choose a valid month." };
  if (month > current) return { ok: false, error: "That month has not started yet." };
  const monthStart = `${month}-01`;
  return { ok: true, value: { month, monthStart, monthEnd: monthEndOf(monthStart), inProgress: month === current } };
}

// ── Visits per rep per day ──────────────────────────────────────────────────────────────────────

export type VisitCounts = { visits: number; doubleVisits: number; chainVisits: number; farVisits: number; testVisits: number };

export function emptyVisitCounts(): VisitCounts {
  return { visits: 0, doubleVisits: 0, chainVisits: 0, farVisits: 0, testVisits: 0 };
}

function addVisitCounts(target: VisitCounts, source: VisitCounts): void {
  target.visits += source.visits;
  target.doubleVisits += source.doubleVisits;
  target.chainVisits += source.chainVisits;
  target.farVisits += source.farVisits;
  target.testVisits += source.testVisits;
}

export type RepVisitDay = { date: string; am: VisitCounts; pm: VisitCounts };

export type RepVisitGroup = {
  seatId: string;
  /** Null for visits a manager entered on their own (no rep on the visit). */
  repHrId: string | null;
  days: RepVisitDay[];
  /** Days with at least one visit. */
  visitDays: number;
  am: VisitCounts;
  pm: VisitCounts;
};

/** phoenix_crm_report_visits_by_day rows → one group per territory and rep, days in date order. */
export function groupVisitsByRep(rows: ReadonlyArray<Row>): { groups: RepVisitGroup[]; totals: ByList<VisitCounts> } {
  const groups = new Map<string, RepVisitGroup & { byDay: Map<string, RepVisitDay> }>();
  const totals: ByList<VisitCounts> = { AM: emptyVisitCounts(), PM: emptyVisitCounts() };
  for (const row of rows) {
    const seatId = textOf(row.seat_id);
    const date = textOf(row.visit_date);
    if (!seatId || !date) continue;
    const repHrId = textOf(row.rep_hr_id);
    const key = `${seatId}|${repHrId ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { seatId, repHrId, days: [], visitDays: 0, am: emptyVisitCounts(), pm: emptyVisitCounts(), byDay: new Map() };
      groups.set(key, group);
    }
    let day = group.byDay.get(date);
    if (!day) {
      day = { date, am: emptyVisitCounts(), pm: emptyVisitCounts() };
      group.byDay.set(date, day);
    }
    const counts: VisitCounts = {
      visits: count(row.visits),
      doubleVisits: count(row.double_visits),
      chainVisits: count(row.chain_visits),
      farVisits: count(row.far_visits),
      testVisits: count(row.test_visits),
    };
    const listType = listTypeOf(row.list_type);
    addVisitCounts(listType === "AM" ? day.am : day.pm, counts);
    addVisitCounts(listType === "AM" ? group.am : group.pm, counts);
    addVisitCounts(totals[listType], counts);
  }
  const result = [...groups.values()].map(({ byDay, ...group }) => {
    const days = [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date));
    return { ...group, days, visitDays: days.filter((day) => day.am.visits + day.pm.visits > 0).length };
  });
  return { groups: result, totals };
}

// ── Plan against actual ─────────────────────────────────────────────────────────────────────────

export type PlanCounts = {
  /** Customers on a plan that reached review (submitted or approved) for the day. */
  planned: number;
  /** Planned customers visited on their planned day. */
  visitedPlanned: number;
  missed: number;
  /** Visits to customers who were not planned for that day. */
  unplanned: number;
};

export function emptyPlanCounts(): PlanCounts {
  return { planned: 0, visitedPlanned: 0, missed: 0, unplanned: 0 };
}

function addPlanCounts(target: PlanCounts, source: PlanCounts): void {
  target.planned += source.planned;
  target.visitedPlanned += source.visitedPlanned;
  target.missed += source.missed;
  target.unplanned += source.unplanned;
}

/** Planned customers visited on the day ÷ planned customers, 0–100 with one decimal. */
export function planKeptPercent(counts: PlanCounts): number | null {
  return sharePercent(counts.visitedPlanned, counts.planned);
}

export type PlanDay = { date: string; am: PlanCounts; pm: PlanCounts };

export type TerritoryPlanGroup = { seatId: string; days: PlanDay[]; am: PlanCounts; pm: PlanCounts };

/** phoenix_crm_report_plan_vs_actual rows → one group per territory, days in date order. */
export function groupPlanByTerritory(rows: ReadonlyArray<Row>): { groups: TerritoryPlanGroup[]; totals: ByList<PlanCounts> } {
  const groups = new Map<string, TerritoryPlanGroup & { byDay: Map<string, PlanDay> }>();
  const totals: ByList<PlanCounts> = { AM: emptyPlanCounts(), PM: emptyPlanCounts() };
  for (const row of rows) {
    const seatId = textOf(row.seat_id);
    const date = textOf(row.day);
    if (!seatId || !date) continue;
    let group = groups.get(seatId);
    if (!group) {
      group = { seatId, days: [], am: emptyPlanCounts(), pm: emptyPlanCounts(), byDay: new Map() };
      groups.set(seatId, group);
    }
    let day = group.byDay.get(date);
    if (!day) {
      day = { date, am: emptyPlanCounts(), pm: emptyPlanCounts() };
      group.byDay.set(date, day);
    }
    const counts: PlanCounts = {
      planned: count(row.planned),
      visitedPlanned: count(row.visited_planned),
      missed: count(row.missed),
      unplanned: count(row.unplanned),
    };
    const listType = listTypeOf(row.list_type);
    addPlanCounts(listType === "AM" ? day.am : day.pm, counts);
    addPlanCounts(listType === "AM" ? group.am : group.pm, counts);
    addPlanCounts(totals[listType], counts);
  }
  const result = [...groups.values()].map(({ byDay, ...group }) => ({
    ...group,
    days: [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date)),
  }));
  return { groups: result, totals };
}

// ── Coverage and frequency ──────────────────────────────────────────────────────────────────────

export type CoverageCounts = {
  customers: number;
  covered: number;
  withTarget: number;
  onTarget: number;
  under: number;
  over: number;
  visits: number;
};

export function emptyCoverageCounts(): CoverageCounts {
  return { customers: 0, covered: 0, withTarget: 0, onTarget: 0, under: 0, over: 0, visits: 0 };
}

function addCoverageCounts(target: CoverageCounts, source: CoverageCounts): void {
  target.customers += source.customers;
  target.covered += source.covered;
  target.withTarget += source.withTarget;
  target.onTarget += source.onTarget;
  target.under += source.under;
  target.over += source.over;
  target.visits += source.visits;
}

export type CoverageCell = CoverageCounts & { coveragePct: number | null; frequencyPct: number | null };

export function coverageCell(counts: CoverageCounts): CoverageCell {
  return {
    ...counts,
    coveragePct: sharePercent(counts.covered, counts.customers),
    frequencyPct: sharePercent(counts.onTarget, counts.withTarget),
  };
}

export type TerritoryCoverageGroup = { seatId: string; am: CoverageCounts; pm: CoverageCounts };

/** phoenix_crm_report_coverage rows → one group per territory. */
export function groupCoverageByTerritory(rows: ReadonlyArray<Row>): { groups: TerritoryCoverageGroup[]; totals: ByList<CoverageCounts> } {
  const groups = new Map<string, TerritoryCoverageGroup>();
  const totals: ByList<CoverageCounts> = { AM: emptyCoverageCounts(), PM: emptyCoverageCounts() };
  for (const row of rows) {
    const seatId = textOf(row.seat_id);
    if (!seatId) continue;
    let group = groups.get(seatId);
    if (!group) {
      group = { seatId, am: emptyCoverageCounts(), pm: emptyCoverageCounts() };
      groups.set(seatId, group);
    }
    const counts: CoverageCounts = {
      customers: count(row.customers),
      covered: count(row.covered),
      withTarget: count(row.with_target),
      onTarget: count(row.on_target),
      under: count(row.under),
      over: count(row.over),
      visits: count(row.visits),
    };
    const listType = listTypeOf(row.list_type);
    addCoverageCounts(listType === "AM" ? group.am : group.pm, counts);
    addCoverageCounts(totals[listType], counts);
  }
  return { groups: [...groups.values()], totals };
}

// ── Double and chain visits per manager ─────────────────────────────────────────────────────────

export type ManagerVisitEntry = {
  date: string;
  seatId: string;
  repHrId: string | null;
  /** "manager" on a double or chain visit; "senior" when above the manager on a chain visit. */
  roleOnVisit: "manager" | "senior";
  doubleVisits: number;
  chainVisits: number;
  amVisits: number;
  pmVisits: number;
};

export type ManagerVisitSummary = {
  /** Double visits as the visit's manager. */
  doubleVisits: number;
  /** Chain visits as the visit's manager. */
  chainVisits: number;
  /** Chain visits as the senior manager. */
  seniorChainVisits: number;
  /** Visits the manager was on, accounts and doctors apart. */
  amVisits: number;
  pmVisits: number;
  /** Days with at least one double or chain visit. */
  daysOut: number;
  /** Different reps the manager went out with. */
  reps: number;
};

export function emptyManagerSummary(): ManagerVisitSummary {
  return { doubleVisits: 0, chainVisits: 0, seniorChainVisits: 0, amVisits: 0, pmVisits: 0, daysOut: 0, reps: 0 };
}

/** phoenix_crm_report_manager_visits rows → each manager's entries (date order) and summary. */
export function groupManagerVisits(rows: ReadonlyArray<Row>): Map<string, { entries: ManagerVisitEntry[]; summary: ManagerVisitSummary }> {
  const byManager = new Map<string, ManagerVisitEntry[]>();
  for (const row of rows) {
    const hrId = textOf(row.hr_id);
    const seatId = textOf(row.seat_id);
    const date = textOf(row.visit_date);
    if (!hrId || !seatId || !date) continue;
    const entries = byManager.get(hrId) ?? [];
    entries.push({
      date,
      seatId,
      repHrId: textOf(row.rep_hr_id),
      roleOnVisit: row.role_on_visit === "senior" ? "senior" : "manager",
      doubleVisits: count(row.double_visits),
      chainVisits: count(row.chain_visits),
      amVisits: count(row.am_visits),
      pmVisits: count(row.pm_visits),
    });
    byManager.set(hrId, entries);
  }
  const result = new Map<string, { entries: ManagerVisitEntry[]; summary: ManagerVisitSummary }>();
  for (const [hrId, entries] of byManager) {
    entries.sort((left, right) => left.date.localeCompare(right.date) || left.seatId.localeCompare(right.seatId));
    const summary = emptyManagerSummary();
    const days = new Set<string>();
    const reps = new Set<string>();
    for (const entry of entries) {
      if (entry.roleOnVisit === "manager") {
        summary.doubleVisits += entry.doubleVisits;
        summary.chainVisits += entry.chainVisits;
      } else {
        summary.seniorChainVisits += entry.chainVisits;
      }
      summary.amVisits += entry.amVisits;
      summary.pmVisits += entry.pmVisits;
      days.add(entry.date);
      if (entry.repHrId) reps.add(entry.repHrId);
    }
    summary.daysOut = days.size;
    summary.reps = reps.size;
    result.set(hrId, { entries, summary });
  }
  return result;
}
