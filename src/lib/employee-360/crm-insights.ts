// Employee 360 — the Phoenix CRM sections (owner, 2026-10-27): plan compliance and visit frequency by
// customer grade.
//
// 🔴 EVERY FIGURE COMES FROM THE PHOENIX CRM SCREEN'S OWN DOMAIN FUNCTION, NEVER A COPY OF ITS RULE
// (`.claude/rules/employees.md`, Employee 360):
//   - a medical rep's plan    → `loadPlanReport` (the Plan vs actual report): planned, kept, missed and
//                               on leave per AM/PM list, plan-kept % from `planKeptPercent`;
//   - a manager's plan        → `managerPlanAdherence` (his landing page's plan card), whose done and
//                               not-done come from `computeManagerReports` → `countManagerOutcomes`;
//   - visit frequency         → `loadCustomerFrequencyReport` (the Frequency report), one territory at a
//                               time as that report reads it, its rows (`customerFrequencyRow`) grouped
//                               here by grade with `customerFrequencyTotals` — never re-scored.
//
// 🔴 BRICK COVERAGE IS NOT HERE, ON PURPOSE. Phoenix CRM's `loadBrickCoverageReport` refuses a medical
// rep (`readsTeamReports`) and has none of the 360 brick section's owner-pinned behaviour (figures from
// the hire month, the latest landed month as a labelled fallback, the seat's whole area including idle
// bricks, the rep's CURRENT list) — so the existing section (`brick-coverage.ts`) stays as it is.
//
// ACCESS IS NOT WIDENED. The page has already decided the viewer may open this subject
// (`canViewEmployee360Subject`). The CRM reads run with a viewer narrowed to the SUBJECT's own scope —
// his own territories as their rep, or the territories under the seats he holds — so a read can only
// ever return the subject's own work or his own team's, whoever is looking.
//
// A read that fails is "unread" and is drawn as "Could not be read", never as 0; a read that returns
// nothing is "empty" and the section is not drawn at all.
//
// The shaping below is pure; the server modules are imported inside the loader so the tests (and any
// client bundle reaching for the types) never load them.

import type { AccessContext } from "@/lib/auth/permissions";
import { monthEndOf, monthStartOf } from "@/lib/phoenix-crm/calendar";
import type { CustomerFrequencyRow } from "@/lib/phoenix-crm/customer-frequency";
import { customerFrequencyTotals } from "@/lib/phoenix-crm/customer-frequency";
import { managerPlanStatusLabel, type ManagerPlanStatus } from "@/lib/phoenix-crm/manager-plan-rules";
import { emptyPlanCounts, planKeptPercent, type PlanCounts } from "@/lib/phoenix-crm/report-rules";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import type { PhoenixCrmDoctorListType, PhoenixCrmGrade } from "@/lib/phoenix-crm/types";
import { employee360CrmInsightRoles, type Employee360CrmInsightState } from "@/lib/employee-360/report-sections";
import type { Employee360RoleCategory } from "@/lib/employee-360/roles";

/** One section's answer: figures, a read that failed, or nothing to draw. */
export type CrmInsight<T> = { state: "data"; value: T } | { state: "unread" } | { state: "empty" };

// ── Plan compliance ─────────────────────────────────────────────────────────────────────────────

/** One list's plan against what happened, summed over the period's months. */
export type CrmRepPlanLine = {
  listType: PhoenixCrmDoctorListType;
  planned: number;
  kept: number;
  /** Planned, visited, but the off-plan visit still waits on a decision — never a miss, never kept. */
  waiting: number;
  missed: number;
  onLeave: number;
  /** `planKeptPercent` over the summed counts; null when nothing was planned. */
  keptPct: number | null;
};

export type CrmRepPlanCompliance = {
  kind: "rep";
  from: string;
  to: string;
  lines: CrmRepPlanLine[];
  /** HR's leave could not be read, so a planning on a leave day may count as missed. */
  leaveUnread: boolean;
  /** The period was longer than the months read; `from` is where the read starts. */
  shortened: boolean;
};

export type CrmManagerPlanWeek = {
  weekStart: string;
  weekEnd: string;
  statusLabel: string;
  /** Planned customers whose day has closed: done or not done. */
  closed: number;
  done: number;
  keptPct: number | null;
};

export type CrmManagerPlanCompliance = {
  kind: "manager";
  from: string;
  to: string;
  weeks: CrmManagerPlanWeek[];
  totals: { weeks: number; closed: number; done: number; keptPct: number | null };
  /** More weeks fall in the period than were read; only the newest are shown. */
  shortened: boolean;
};

export type CrmPlanCompliance = CrmRepPlanCompliance | CrmManagerPlanCompliance;

/** Months of the rep's plan read for one report (each one call of the Plan vs actual report). */
export const CRM_REP_PLAN_MAX_MONTHS = 6;
/** Sent weeks of a manager's plan read for one report (each one manager report). */
export const CRM_MANAGER_PLAN_MAX_WEEKS = 13;

/**
 * The period cut into calendar-month windows, newest kept, each within the Plan vs actual report's
 * 31-day limit. A window starting after today is dropped; the last one is clamped to today.
 */
export function crmPlanMonthWindows(
  from: string,
  to: string,
  cairoToday: string,
  maxMonths = CRM_REP_PLAN_MAX_MONTHS,
): { windows: { from: string; to: string }[]; shortened: boolean } {
  const last = to > cairoToday ? cairoToday : to;
  if (from > last) return { windows: [], shortened: false };
  const windows: { from: string; to: string }[] = [];
  let cursor = monthStartOf(from);
  while (cursor <= last) {
    const end = monthEndOf(cursor);
    windows.push({ from: cursor < from ? from : cursor, to: end > last ? last : end });
    const [year, month] = cursor.slice(0, 7).split("-").map(Number);
    const next = new Date(Date.UTC(year, month, 1));
    cursor = next.toISOString().slice(0, 10);
  }
  if (windows.length <= maxMonths) return { windows, shortened: false };
  return { windows: windows.slice(windows.length - maxMonths), shortened: true };
}

function sumPlanCounts(parts: readonly PlanCounts[]): PlanCounts {
  const total = emptyPlanCounts();
  for (const part of parts) {
    for (const key of Object.keys(total) as (keyof PlanCounts)[]) total[key] += part[key] ?? 0;
  }
  return total;
}

/** The rep's AM and PM lines, summed over the months read. A list with nothing planned is left out. */
export function shapeRepPlanCompliance(input: {
  from: string;
  to: string;
  months: readonly { AM: PlanCounts; PM: PlanCounts; leaveUnread: boolean }[];
  shortened: boolean;
}): CrmInsight<CrmRepPlanCompliance> {
  const lines: CrmRepPlanLine[] = [];
  for (const listType of ["AM", "PM"] as const) {
    const counts = sumPlanCounts(input.months.map((month) => month[listType]));
    if (counts.planned + counts.onLeave + counts.plannedWaiting === 0) continue;
    lines.push({
      listType,
      planned: counts.planned,
      kept: counts.visitedPlanned,
      waiting: counts.plannedWaiting,
      missed: counts.missed,
      onLeave: counts.onLeave,
      keptPct: planKeptPercent(counts),
    });
  }
  if (lines.length === 0) return { state: "empty" };
  return {
    state: "data",
    value: {
      kind: "rep",
      from: input.from,
      to: input.to,
      lines,
      leaveUnread: input.months.some((month) => month.leaveUnread),
      shortened: input.shortened,
    },
  };
}

/** What `managerPlanAdherence` returns per sent week — the fields this section reads. */
export type ManagerPlanAdherenceInput = {
  weekStart: string;
  weekEnd: string;
  status: ManagerPlanStatus;
  checkable: number;
  kept: number;
  scorePct: number | null;
};

/**
 * A manager's sent weeks that touch the period, newest first, and their sum. The week's kept % is
 * `managerPlanAdherence`'s own; the period's is the same ratio — done over done plus not done — on the
 * summed counts, never an average of the weeks' percentages.
 */
export function shapeManagerPlanCompliance(input: {
  from: string;
  to: string;
  weeks: readonly ManagerPlanAdherenceInput[];
  shortened: boolean;
}): CrmInsight<CrmManagerPlanCompliance> {
  const inPeriod = input.weeks
    .filter((week) => week.weekStart <= input.to && week.weekEnd >= input.from)
    .sort((left, right) => right.weekStart.localeCompare(left.weekStart));
  if (inPeriod.length === 0) return { state: "empty" };
  const weeks = inPeriod.map((week) => ({
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    statusLabel: managerPlanStatusLabel(week.status),
    closed: week.checkable,
    done: week.kept,
    keptPct: week.scorePct,
  }));
  const closed = weeks.reduce((sum, week) => sum + week.closed, 0);
  const done = weeks.reduce((sum, week) => sum + week.done, 0);
  return {
    state: "data",
    value: {
      kind: "manager",
      from: input.from,
      to: input.to,
      weeks,
      totals: { weeks: weeks.length, closed, done, keptPct: closed > 0 ? Math.round((done / closed) * 100) : null },
      shortened: input.shortened,
    },
  };
}

// ── Visit frequency by customer grade ───────────────────────────────────────────────────────────

export type CrmGradeFrequencyRow = {
  listType: PhoenixCrmDoctorListType;
  grade: PhoenixCrmGrade | null;
  /** "Grade A · AM list", "No grade · PM list". */
  label: string;
  customers: number;
  /** The grade's monthly number from Phoenix CRM's settings; null when the company set none. */
  target: number | null;
  visits: number;
  /** Visits per customer, one decimal. */
  averageVisits: number;
  under: number;
  onTarget: number;
  over: number;
  noTarget: number;
};

export type CrmFrequency = {
  /** "2026-10". */
  month: string;
  inProgress: boolean;
  /** The territories read. */
  territories: number;
  rows: CrmGradeFrequencyRow[];
  totals: { customers: number; under: number; onTarget: number; over: number; noTarget: number };
  /** Visits to customers not yet validated, counted in nothing — said beside the table. */
  awaitingValidation: number;
  leaveUnread: boolean;
};

/** Territories read for one manager's team frequency (one Frequency report call each). */
export const CRM_FREQUENCY_MAX_TERRITORIES = 15;

const GRADE_ORDER: readonly (PhoenixCrmGrade | null)[] = ["A", "B", "C", null];
const LIST_ORDER: readonly PhoenixCrmDoctorListType[] = ["AM", "PM"];

/** One row per grade and list (Phoenix CRM's targets are keyed by both), A to C then no grade, AM before PM. */
export function gradeFrequencyRows(rows: readonly CustomerFrequencyRow[]): CrmGradeFrequencyRow[] {
  const out: CrmGradeFrequencyRow[] = [];
  for (const grade of GRADE_ORDER) {
    for (const listType of LIST_ORDER) {
      const group = rows.filter((row) => (row.grade ?? null) === grade && row.listType === listType);
      if (group.length === 0) continue;
      const totals = customerFrequencyTotals(group);
      const visits = group.reduce((sum, row) => sum + row.visits, 0);
      const target = group.find((row) => row.gradeTarget !== null)?.gradeTarget ?? null;
      out.push({
        listType,
        grade,
        label: `${grade ? `Grade ${grade}` : "No grade"} · ${listType} list`,
        customers: totals.customers,
        target,
        visits,
        averageVisits: Math.round((visits / group.length) * 10) / 10,
        under: totals.under,
        onTarget: totals.onTarget,
        over: totals.over,
        noTarget: totals.noTarget,
      });
    }
  }
  return out;
}

/** The territories' Frequency reports, joined. Any one failing read makes the whole section unread. */
export function shapeFrequency(input: {
  month: string;
  inProgress: boolean;
  reports: readonly { rows: readonly CustomerFrequencyRow[]; awaitingValidation: number; leaveUnread: boolean }[];
}): CrmInsight<CrmFrequency> {
  const all = input.reports.flatMap((report) => report.rows);
  if (all.length === 0) return { state: "empty" };
  return {
    state: "data",
    value: {
      month: input.month,
      inProgress: input.inProgress,
      territories: input.reports.length,
      rows: gradeFrequencyRows(all),
      totals: customerFrequencyTotals(all),
      awaitingValidation: input.reports.reduce((sum, report) => sum + report.awaitingValidation, 0),
      leaveUnread: input.reports.some((report) => report.leaveUnread),
    },
  };
}

// ── The report's two signals ────────────────────────────────────────────────────────────────────

export type Employee360CrmInsights = {
  planCompliance: CrmInsight<CrmPlanCompliance> | null;
  frequency: CrmInsight<CrmFrequency> | null;
};

/** Every section the role carries, as a read that failed — for a loader that could not start at all. */
export function unreadCrmInsights(category: Employee360RoleCategory): Employee360CrmInsights {
  const roles = employee360CrmInsightRoles(category);
  return {
    planCompliance: roles.repPlan || roles.managerPlan ? { state: "unread" } : null,
    frequency: roles.frequency ? { state: "unread" } : null,
  };
}

/** The state the section plan reads; a section the role never loads has no state. */
export function crmInsightState(insight: CrmInsight<unknown> | null | undefined): Employee360CrmInsightState | undefined {
  return insight ? insight.state : undefined;
}

// ── The loader ──────────────────────────────────────────────────────────────────────────────────

async function settle<T>(read: () => Promise<CrmInsight<T>>): Promise<CrmInsight<T>> {
  try {
    return await read();
  } catch (error) {
    console.error("[employee-360] Phoenix CRM read failed", error);
    return { state: "unread" };
  }
}

/**
 * The Phoenix CRM sections for one subject the viewer may already open. `viewerAccess` is the page's
 * own access context — it supplies the organogram, the settings and Cairo's day, never the scope.
 */
export async function loadEmployee360CrmInsights(input: {
  viewerAccess: AccessContext;
  subjectHrId: string;
  category: Employee360RoleCategory;
  from: string;
  to: string;
}): Promise<Employee360CrmInsights> {
  const roles = employee360CrmInsightRoles(input.category);
  const { currentCairoDateOnlyIso } = await import("@/lib/i18n/format");
  const cairoToday = currentCairoDateOnlyIso();

  // The subject's own CRM view: built once, only when a section that needs it is loaded.
  let subjectViewer: Promise<PhoenixCrmViewer | null> | null = null;
  const viewerOfSubject = () => {
    subjectViewer ??= (async () => {
      const { resolvePhoenixCrmViewer } = await import("@/lib/phoenix-crm/server/access");
      const { heldManagerSeats, ownTerritories, personKey, territoriesInScope } = await import("@/lib/phoenix-crm/scope");
      const base = await resolvePhoenixCrmViewer(input.viewerAccess);
      const hrId = personKey(input.subjectHrId);
      if (!hrId) return null;
      const isOpen = (seat: { lineCode: string | null }) => Boolean(seat.lineCode && base.openLines.has(seat.lineCode));
      const held = ownTerritories(base.org, hrId);
      const scope = territoriesInScope(base.org, hrId, "tree");
      const narrowed: PhoenixCrmViewer = {
        ...base,
        hrId,
        isSuperAdmin: false,
        isSfeManager: false,
        basis: "tree" as const,
        canCreate: false,
        canApprove: false,
        canUpdate: false,
        ownTerritories: held.filter(isOpen),
        waitingTerritories: held.filter((seat) => !isOpen(seat)),
        scopeTerritories: scope.filter(isOpen),
        waitingScopeTerritories: scope.filter((seat) => !isOpen(seat)),
        managerSeats: heldManagerSeats(base.org, hrId),
        plansAsProductManager: false,
        plansAsTrainingManager: false,
      };
      return narrowed;
    })();
    return subjectViewer;
  };

  const planRead: Promise<CrmInsight<CrmPlanCompliance> | null> = roles.repPlan
    ? settle(async () => {
        const viewer = await viewerOfSubject();
        if (!viewer) return { state: "empty" };
        const { loadPlanReport } = await import("@/lib/phoenix-crm/server/reports");
        const { windows, shortened } = crmPlanMonthWindows(input.from, input.to, viewer.cairoToday);
        if (windows.length === 0) return { state: "empty" };
        const months = await Promise.all(windows.map((window) => loadPlanReport(viewer, { from: window.from, to: window.to })));
        return shapeRepPlanCompliance({
          from: windows[0].from,
          to: windows[windows.length - 1].to,
          months: months.map((month) => ({ AM: month.totals.AM, PM: month.totals.PM, leaveUnread: month.leaveUnread })),
          shortened,
        });
      })
    : roles.managerPlan
      ? settle(async () => {
          const { managerPlanAdherence } = await import("@/lib/phoenix-crm/server/manager-plan-readers");
          const { cairoBusinessDay } = await import("@/lib/phoenix-crm/calendar");
          const { addDaysIso } = await import("@/lib/crm/dates");
          // Enough of his newest sent weeks to reach back to the period's first week, capped.
          let weeksBack = 1;
          for (let day = input.from; day <= cairoToday && weeksBack <= CRM_MANAGER_PLAN_MAX_WEEKS; day = addDaysIso(day, 7)) weeksBack += 1;
          const shortened = weeksBack > CRM_MANAGER_PLAN_MAX_WEEKS;
          const weeks = await managerPlanAdherence(
            input.subjectHrId,
            { cairoToday, visitDay: cairoBusinessDay(new Date()) },
            Math.min(weeksBack, CRM_MANAGER_PLAN_MAX_WEEKS),
          );
          return shapeManagerPlanCompliance({ from: input.from, to: input.to > cairoToday ? cairoToday : input.to, weeks, shortened });
        })
      : Promise.resolve(null);

  const frequencyRead: Promise<CrmInsight<CrmFrequency> | null> = roles.frequency
    ? settle(async () => {
        const viewer = await viewerOfSubject();
        if (!viewer) return { state: "empty" };
        const seats = input.category === "medical-rep" ? viewer.ownTerritories : viewer.scopeTerritories;
        if (seats.length === 0) return { state: "empty" };
        // A team wider than the cap would be a partial answer that reads as a whole one: not drawn.
        if (seats.length > CRM_FREQUENCY_MAX_TERRITORIES) return { state: "empty" };
        const { loadCustomerFrequencyReport } = await import("@/lib/phoenix-crm/server/reports");
        // The Frequency report reads one calendar month: the month the period ends in (today's, at most).
        const lastDay = input.to > viewer.cairoToday ? viewer.cairoToday : input.to;
        const month = lastDay.slice(0, 7);
        const reports = await Promise.all(seats.map((seat) => loadCustomerFrequencyReport(viewer, { seatId: seat.seatId, month })));
        return shapeFrequency({
          month,
          inProgress: reports[0]?.month.inProgress ?? false,
          reports: reports.map((report) => ({ rows: report.rows, awaitingValidation: report.awaitingValidation, leaveUnread: report.leaveUnread })),
        });
      })
    : Promise.resolve(null);

  const [planCompliance, frequency] = await Promise.all([planRead, frequencyRead]);
  return { planCompliance, frequency };
}
