// Business Review — the CRM's own KPIs, read from the CRM KPIs board itself.
//
// Owner, 2026-10-01, asked whether to add them: "add all three" — each rep's COVERAGE and FREQUENCY
// against his own plan, and his CALL RATE, AM against 2 a day and PM against 10, reported apart and
// never averaged.
//
// 🔴 THE BOARD IS THE AUTHORITY, NOT A COPY OF IT. Coverage, frequency and the call rate carry a stack
// of owner rulings — the plan as the denominator, an over-visit as a deviation, the call rate scored
// through yesterday, GPS-proved calls before the cutover, "No GPS feed" (ruling A1), holidays out of
// the denominator, medical reps only — and every one of them lives in `getKpisBoard`. So this module
// asks the board, one board per month of the window, and keeps the rows of the pack's own reps. A
// rep's figure here is therefore the figure the KPIs board prints for him that month, and a team
// figure is `kpiTeamFigures`, the function the board's own tiles read.
//
// 🔴 SCOPE IS THE VIEWER'S, TWICE OVER. The board scopes to the viewer's doctor-coverage scope (a rep
// sees himself, a district manager his reps), and the rows are then cut to the reps the pack itself
// survived to — so a row reaches the pack only when BOTH boundaries allow it. Read at export time,
// per viewer, never cached.

import type { AccessContext } from "@/lib/auth/permissions";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getKpisBoard, kpiTeamFigures, sumKpiTeamTotals, type KpiRepRow } from "@/lib/crm/kpis-board";
import type { KpiRules } from "@/lib/crm/phoenix-kpi-rules";
import { tidyAllCapitalsName } from "@/lib/employees/display-name";
import { canonicalHrIdKey } from "@/lib/hr-id";

/** A team's plan KPIs and call rate, in the board's own arithmetic. */
export type ReviewKpiTeam = ReturnType<typeof kpiTeamFigures> & {
  reps: number;
  plannedDoctors: number;
  visitedDoctors: number;
  onPlanDoctors: number;
  /** Reps whose CRM account sent no GPS check-in (ruling A1) — out of the call-rate figures. */
  noGpsFeedReps: number;
};

export type ReviewKpiMonth = {
  /** YYYY-MM. */
  month: string;
  /** True when this month's board could not be read — said on the page, never drawn as zeros. */
  unread: boolean;
  /** "legacy" before the CRM cutover, "phoenix" after it — the board's own phase-6 rules. */
  rules: KpiRules;
  /** False when a holiday calendar could not be read: every call rate may then read LOW. */
  holidaysComplete: boolean;
  /** The working days every call rate of the month divides by. */
  workingDays: number;
  /** The pack's reps who have a row on the board this month. */
  rows: KpiRepRow[];
  /** Everyone above as one team. */
  team: ReviewKpiTeam;
  /** By the manager the employee directory gives each rep — "No manager recorded" when it gives none. */
  teams: { managerName: string; figures: ReviewKpiTeam }[];
};

export const NO_MANAGER_RECORDED = "No manager recorded";

/** The team figures over these rows. Pure. */
export function reviewKpiTeam(rows: readonly KpiRepRow[], rules: KpiRules): ReviewKpiTeam {
  const totals = sumKpiTeamTotals(rows);
  return {
    ...kpiTeamFigures(totals, rules),
    noGpsFeedReps: rows.filter((row) => row.noGpsFeed).length,
    onPlanDoctors: totals.onPlanDoctors,
    plannedDoctors: totals.plannedDoctors,
    reps: totals.reps,
    visitedDoctors: totals.visitedDoctors,
  };
}

/**
 * One month of the board, cut to the pack's reps and rolled up. Pure, so the cut can be tested
 * without a database. Hr ids are matched on `canonicalHrIdKey` — the key the board itself stamps on
 * every row — because production stores them in mixed case and carries renamed ids in an alias
 * table, and either difference makes a plain equality silently drop a rep.
 */
export function reviewKpiMonthOf(input: {
  month: string;
  rules: KpiRules;
  holidaysComplete: boolean;
  workingDays: number;
  boardRows: readonly KpiRepRow[];
  repHrIds: readonly string[];
}): ReviewKpiMonth {
  const wanted = new Set(input.repHrIds.map((hrId) => canonicalHrIdKey(hrId)).filter((key): key is string => !!key));
  const rows = input.boardRows.filter((row) => {
    const key = canonicalHrIdKey(row.agentHrId);
    return key != null && wanted.has(key);
  });
  const byManager = new Map<string, KpiRepRow[]>();
  for (const row of rows) {
    const manager = tidyAllCapitalsName(row.managerName?.trim() ?? "") || NO_MANAGER_RECORDED;
    byManager.set(manager, [...(byManager.get(manager) ?? []), row]);
  }
  return {
    holidaysComplete: input.holidaysComplete,
    month: input.month,
    rows,
    rules: input.rules,
    team: reviewKpiTeam(rows, input.rules),
    teams: [...byManager.entries()]
      .map(([managerName, members]) => ({ figures: reviewKpiTeam(members, input.rules), managerName }))
      .sort(
        (a, b) =>
          Number(a.managerName === NO_MANAGER_RECORDED) - Number(b.managerName === NO_MANAGER_RECORDED) ||
          a.managerName.localeCompare(b.managerName),
      ),
    unread: false,
    workingDays: input.workingDays,
  };
}

/**
 * Every month of the window, one board each, in order.
 *
 * ONE MONTH AT A TIME, never all at once: a company-wide board holds a whole month of visits and
 * plans in memory, and a semester read in parallel would hold six. A rep's or a small district's
 * board reads only its own people's rows (crm/kpi-board-agents.ts), so for them the loop is quick.
 * `includeReports: false` — the pack prints neither per-rep report, and the board's rows never read
 * them (see getKpisBoard).
 */
export async function loadReviewKpiMonths(input: {
  access: AccessContext;
  months: readonly string[];
  repHrIds: readonly string[];
}): Promise<ReviewKpiMonth[]> {
  const todayIso = cairoTodayIso();
  const months: ReviewKpiMonth[] = [];
  for (const month of input.months) {
    try {
      const board = await getKpisBoard({ access: input.access, includeReports: false, month, todayIso });
      months.push(
        reviewKpiMonthOf({
          boardRows: board.reps,
          holidaysComplete: board.holidaysComplete,
          month,
          repHrIds: input.repHrIds,
          rules: board.kpiRules ?? "legacy",
          workingDays: board.workingDays,
        }),
      );
    } catch {
      // That month says it could not be read; the others still stand on their own boards.
      months.push({ ...reviewKpiMonthOf({ boardRows: [], holidaysComplete: true, month, repHrIds: [], rules: "legacy", workingDays: 0 }), unread: true });
    }
  }
  return months;
}
