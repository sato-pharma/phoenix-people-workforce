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

import { addDaysIso } from "@/lib/crm/dates";
import { isIsoDay, isMonthKey, monthEndOf, monthStartOf } from "@/lib/phoenix-crm/calendar";
import { sharePercent } from "@/lib/phoenix-crm/coverage";
import { isLeaveDay, NO_LEAVE_DAYS, type LeaveDays } from "@/lib/phoenix-crm/plan-leave";
import { doctorListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import type { PhoenixCrmDoctorListType } from "@/lib/phoenix-crm/types";

export const REPORT_MAX_DAYS = 31;

export type ReportRuleResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type ByList<T> = Record<PhoenixCrmDoctorListType, T>;

type Row = Record<string, unknown>;

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

// Every figure in this file is a KPI — visits per half-day, plan against actual, coverage and
// frequency — and a pharmacy is in none of them (owner, 2026-10-02). null means "not one of the
// two halves", and each caller skips the row rather than adding it to the doctors.
function listTypeOf(value: unknown): PhoenixCrmDoctorListType | null {
  return doctorListType(value);
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

// ── Comparison (C3) ─────────────────────────────────────────────────────────────────────────────

/**
 * What a figure is read AGAINST.
 *
 *   - `off`      the figure alone — the default, and what every reader had until now.
 *   - `previous` the same LENGTH of days immediately before this period: "did we improve?"
 *   - `peers`    the AVERAGE PER TERRITORY across the viewer's whole scope, over the same days.
 *
 * 🔴 **Peer mode is an anonymous average and never a league table.** It answers "is this territory
 * behind the rest of my district", which is a management question, and refuses to answer "who is
 * worst", which is a different question wearing the same clothes. No name, no rank and no "3rd of
 * 12" ever leaves this module: a board that ranks named people turns a manager's read into something
 * the field force learns to game, and the owner has not asked for one.
 *
 * Manager-only in v1 — a rep shown "the average" is being shown his colleagues' work in aggregate,
 * the same disclosure the place-vs-actual report withholds from him (owner, 2026-09-26).
 */
export type ComparisonMode = "off" | "previous" | "peers";

export function isComparisonMode(value: unknown): value is ComparisonMode {
  return value === "off" || value === "previous" || value === "peers";
}

/**
 * The same LENGTH of days immediately before a period.
 *
 * Length, not "the previous calendar month": the period a manager picks is usually a part-month — the
 * 1st to today — and reading eleven worked days against a whole thirty-day month would show every
 * territory collapsing. Same number of days, ending the day before this period starts.
 */
export function previousPeriod(period: ReportPeriod): ReportPeriod {
  const days = daysInPeriod(period.from, period.to);
  const to = addDaysIso(period.from, -1);
  return { from: addDaysIso(to, -(days - 1)), to };
}

export type Delta = {
  /** What the figure is read against. Null when there is nothing to read it against. */
  baseline: number | null;
  /** now − baseline; null when there is no baseline. */
  change: number | null;
  /**
   * The change as a percentage of the baseline, one decimal — null when the baseline is 0.
   *
   * 🔴 A rise from zero has NO percentage, and inventing one ("+100%", "new") is how a board starts
   * shouting about a rep who made one visit. The change itself is still there and still true.
   */
  changePct: number | null;
  /** Worked out here so no screen has to read a sign and get it wrong. */
  direction: "up" | "down" | "same";
};

export function delta(now: number, baseline: number | null): Delta {
  if (baseline === null) return { baseline: null, change: null, changePct: null, direction: "same" };
  const change = now - baseline;
  return {
    baseline,
    change,
    changePct: baseline === 0 ? null : Math.round((change / baseline) * 1000) / 10,
    direction: change > 0 ? "up" : change < 0 ? "down" : "same",
  };
}

/**
 * The average per territory, for peer mode.
 *
 * Divided by the number of TERRITORIES, never by the number that happen to have a figure: a territory
 * with no visits is part of its district's average, and dropping it would flatter the whole set and
 * make every working rep look merely average. No territories has no average — null, not 0.
 */
export function averagePerTerritory(total: number, territories: number): number | null {
  return territories <= 0 ? null : Math.round((total / territories) * 10) / 10;
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

export type VisitCounts = {
  visits: number;
  doubleVisits: number;
  chainVisits: number;
  /**
   * Visits saved far from the customer's place. ABSENT, never zero, on a seat the viewer is blind on
   * (`readsSeatLocations`): a rep reading his own territory must not receive the field at all, because a
   * JSON field his browser receives counts as shown even when the screen hides it (Golden Rule #1).
   */
  farVisits?: number;
  testVisits: number;
  /**
   * Off-plan visits still waiting for a decision — BESIDE the count, never inside it.
   *
   * `visits` already leaves them out, which is the rule. This says how many, because a day that reads
   * low only because three visits are with the manager must say so: without it the dip reads as a rep
   * who did not work, and that is a wrong thing to believe about a real person.
   */
  unplannedWaiting: number;
};

export function emptyVisitCounts(): VisitCounts {
  return { visits: 0, doubleVisits: 0, chainVisits: 0, farVisits: 0, testVisits: 0, unplannedWaiting: 0 };
}

function addVisitCounts(target: VisitCounts, source: VisitCounts): void {
  target.visits += source.visits;
  target.doubleVisits += source.doubleVisits;
  target.chainVisits += source.chainVisits;
  target.farVisits = (target.farVisits ?? 0) + (source.farVisits ?? 0);
  target.testVisits += source.testVisits;
  target.unplannedWaiting += source.unplannedWaiting;
}

export type RepVisitDay = { date: string; am: VisitCounts; pm: VisitCounts };

export type RepVisitGroup = {
  seatId: string;
  /** Null for visits a manager entered on their own (no rep on the visit). */
  repHrId: string | null;
  /**
   * The manager who made these visits on their own — set ONLY where `repHrId` is null, so two managers
   * on one territory are two groups and no longer one anonymous line. Null on every rep group: a
   * ride-along stays on the rep it was made with.
   */
  managerHrId: string | null;
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
    const managerHrId = repHrId === null ? textOf(row.manager_hr_id) : null;
    const key = `${seatId}|${repHrId ?? ""}|${managerHrId ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { seatId, repHrId, managerHrId, days: [], visitDays: 0, am: emptyVisitCounts(), pm: emptyVisitCounts(), byDay: new Map() };
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
      unplannedWaiting: count(row.unplanned_waiting),
    };
    const listType = listTypeOf(row.list_type);
    if (listType === null) continue;
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
  /**
   * Customers on a plan that reached review (submitted or approved) for the day — less the ones on a
   * day HR approved his leave that he did not see, which are `onLeave` instead. So it is the plan he
   * could have kept, and plan-kept % divides by it unchanged.
   */
  planned: number;
  /** Planned customers visited on their planned day, on a visit that was itself planned. */
  visitedPlanned: number;
  /**
   * Planned, visited, but the visit was off-plan and is still waiting on a decision.
   *
   * It exists so that a customer the rep DID see cannot read as a miss while his visit sits with the
   * manager. It is never part of plan-kept %, for the same reason `unplanned` is not.
   */
  plannedWaiting: number;
  /** Planned, and not visited on the day. Never a day HR approved his leave — that is `onLeave`. */
  missed: number;
  /**
   * Planned on a day HR approved his leave, and not visited (owner, 2026-10-01: "fix missed visits on
   * leave days in plan vs actual"). Never a miss, and out of `planned`, so plan-kept % is measured
   * over the days he was there. `plan-leave.ts` holds the rule, for all three reports that read it.
   */
  onLeave: number;
  /** Visits to customers who were not planned for that day — every one of them, decided or not. */
  unplanned: number;
  /** Of those, the ones still with the manager or with SFE, so counting in nothing yet. */
  unplannedWaiting: number;
  /** Of those, the ones refused — they happened, and they never count. */
  unplannedRefused: number;
};

export function emptyPlanCounts(): PlanCounts {
  return { planned: 0, visitedPlanned: 0, plannedWaiting: 0, missed: 0, onLeave: 0, unplanned: 0, unplannedWaiting: 0, unplannedRefused: 0 };
}

function addPlanCounts(target: PlanCounts, source: PlanCounts): void {
  target.planned += source.planned;
  target.visitedPlanned += source.visitedPlanned;
  target.plannedWaiting += source.plannedWaiting;
  target.missed += source.missed;
  target.onLeave += source.onLeave;
  target.unplanned += source.unplanned;
  target.unplannedWaiting += source.unplannedWaiting;
  target.unplannedRefused += source.unplannedRefused;
}

/**
 * Planned customers visited on the day ÷ planned customers, 0–100 with one decimal.
 *
 * Neither off-plan figure may ever enter this ratio, whatever it has been approved as: the denominator
 * is what the rep PLANNED, and a visit he did not plan cannot make him better or worse at keeping the
 * plan he did make. Nor may a day HR approved his leave: `planned` already leaves those customers out
 * (`onLeave`), so a week of annual leave cannot pull this down.
 */
export function planKeptPercent(counts: PlanCounts): number | null {
  return sharePercent(counts.visitedPlanned, counts.planned);
}

export type PlanDay = { date: string; am: PlanCounts; pm: PlanCounts };

export type TerritoryPlanGroup = { seatId: string; days: PlanDay[]; am: PlanCounts; pm: PlanCounts };

/**
 * phoenix_crm_report_plan_vs_actual rows → one group per territory, days in date order.
 *
 * `leave` is the days HR approved the rep's leave (`server/leave-days.ts`). The function knows
 * nothing of leave, so it is applied here: on such a day every planned customer he did not see moves
 * from `missed` to `onLeave`, and out of `planned` with it. A customer he DID see that day stays a
 * kept plan — the visit happened.
 */
export function groupPlanByTerritory(
  rows: ReadonlyArray<Row>,
  leave: LeaveDays = NO_LEAVE_DAYS,
): { groups: TerritoryPlanGroup[]; totals: ByList<PlanCounts> } {
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
    const missed = count(row.missed);
    const onLeave = isLeaveDay(leave, seatId, date) ? missed : 0;
    const counts: PlanCounts = {
      planned: count(row.planned) - onLeave,
      visitedPlanned: count(row.visited_planned),
      plannedWaiting: count(row.planned_waiting),
      missed: missed - onLeave,
      onLeave,
      unplanned: count(row.unplanned),
      unplannedWaiting: count(row.unplanned_waiting),
      unplannedRefused: count(row.unplanned_refused),
    };
    const listType = listTypeOf(row.list_type);
    if (listType === null) continue;
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
    if (listType === null) continue;
    addCoverageCounts(listType === "AM" ? group.am : group.pm, counts);
    addCoverageCounts(totals[listType], counts);
  }
  return { groups: [...groups.values()], totals };
}

// ── Double and chain visits per manager ─────────────────────────────────────────────────────────

/**
 * Where a person stood on the visit — the three columns a non-rep can occupy, and the reason the
 * report is grouped by it. A person who was the manager of one visit and the line's product manager
 * on another gets one entry per role on the same day, and the summary adds each under its own
 * heading: a product manager's visits are NEVER folded into `doubleVisits`, which is the figure
 * district managers are measured on (CLAUDE.md, the 2026-10-02 lock).
 */
export type ManagerVisitRole = "manager" | "senior" | "product_manager";

export type ManagerVisitEntry = {
  date: string;
  seatId: string;
  repHrId: string | null;
  /**
   * "manager" on a double or chain visit; "senior" when above the manager on a chain visit;
   * "product_manager" when he is the line's product manager the rep ticked (the `product_manager`
   * kind, or the second person on a chain).
   */
  roleOnVisit: ManagerVisitRole;
  doubleVisits: number;
  chainVisits: number;
  /** Visits of the `product_manager` kind — the rep ticked ONE product manager under "Double visit". */
  productManagerVisits: number;
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
  /** Visits as the line's product manager — the `product_manager` kind. Never inside `doubleVisits`. */
  productManagerVisits: number;
  /** Chain visits where he was the product manager rather than a manager. */
  productManagerChainVisits: number;
  /** Visits the manager was on, accounts and doctors apart. */
  amVisits: number;
  pmVisits: number;
  /** Days with at least one double or chain visit. */
  daysOut: number;
  /** Different reps the manager went out with. */
  reps: number;
};

export function emptyManagerSummary(): ManagerVisitSummary {
  return {
    doubleVisits: 0,
    chainVisits: 0,
    seniorChainVisits: 0,
    productManagerVisits: 0,
    productManagerChainVisits: 0,
    amVisits: 0,
    pmVisits: 0,
    daysOut: 0,
    reps: 0,
  };
}

/** The role the row names, read as the function spells it; anything else is the manager's place. */
function managerVisitRole(raw: unknown): ManagerVisitRole {
  if (raw === "senior") return "senior";
  if (raw === "product_manager") return "product_manager";
  return "manager";
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
      roleOnVisit: managerVisitRole(row.role_on_visit),
      doubleVisits: count(row.double_visits),
      chainVisits: count(row.chain_visits),
      productManagerVisits: count(row.product_manager_visits),
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
      } else if (entry.roleOnVisit === "product_manager") {
        summary.productManagerVisits += entry.productManagerVisits;
        summary.productManagerChainVisits += entry.chainVisits;
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
