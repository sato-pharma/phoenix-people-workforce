// ─────────────────────────────────────────────────────────────────────────────
// KPIs · the Weekly tab — the same three KPIs, cut by TIME.
//
// OWNER, 2026-09-22: "calculate his call rate and coverage and frequency, the same things now, but I
// want to be able to track them by week. So week one ... week two, week three, week four, months
// consolidated, a quarter, semester ... what appears on the screen is the weekly and the
// consolidation. For example, we are week three now in September, so I appear week one, week two,
// week three, and the total consolidated month of those three."
//
// So every view is "the pieces, and what they add up to":
//
//   Month by week       the weeks that have begun, then the month through the last of them
//   Quarter by month    the quarter's months that have begun, then the quarter so far
//   Semester by month   the half-year's months that have begun, then the semester so far
//
// NOTHING IS RE-DERIVED HERE. Every week and every month is one ordinary `getKpisBoard` for that
// window: the same scope gate, the same medical-reps-only rule, the same ruling A1 and C1, the same
// cutover switch. A week on this tab is therefore the SAME NUMBER a manager gets by picking that week
// on the Summary tab, and the month total is the same number the Summary tab prints for the same
// span. The only arithmetic this file adds is the quarter and semester sum, which no board covers,
// and it adds counts, never percentages: calls over days, doctors reached over doctors planned.
//
// AM, PM and pharmacy stay three measures throughout — the owner's rule of 2026-09-04 ("this two and
// this ten. Don't never get average") binds a sum over months exactly as it binds one month.
//
// SCOPE IS STILL THE SECURITY BOUNDARY: each board resolves the viewer's scope itself, so no column
// can hold a rep another column could not.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext } from "@/lib/auth/permissions";
import { AM_CALL_RATE_TARGET, PHARMACY_CALL_RATE_TARGET, PM_CALL_RATE_TARGET } from "@/lib/crm/call-rate";
import {
  attainmentPct,
  CRM_DATA_FLOOR_MONTH,
  getKpisBoard,
  type KpiRepRow,
  type KpisBoard,
} from "@/lib/crm/kpis-board";
import {
  applyKpiFilters,
  COVERAGE_TARGET_FLOOR_PCT,
  EMPTY_KPI_FILTERS,
  type KpiFilterState,
} from "@/lib/crm/kpis-filters";
import type { KpiTrendScale } from "@/lib/crm/kpis-trend-options";
import { monthLabelOf } from "@/lib/crm/rep-doctor-lists";
import { repsPlansRange, repsPlansWeeks } from "@/lib/crm/reps-plans";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";

// ── The plan: which columns the view shows ─────────────────────────────────────────────────────

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One column of the view: a week, a month, or the consolidated total after them. */
export type KpiTrendColumnPlan = {
  /** `w1`…`w5`, a month key such as `2026-07`, or `total`. */
  key: string;
  kind: "week" | "month" | "total";
  /** The column head: "Week 1", "Jul", "Month", "Q3", "S2". Short on purpose — see kpis-trend-view.tsx. */
  label: string;
  /** The line under the head: the days it spans, "1–7 Sep", "Jul – Sep". */
  span: string;
  /**
   * The month and period one board is built for. Null period on the quarter and semester TOTAL,
   * which no single board can cover — it is summed from the month columns before it.
   */
  month: string;
  period: string | null;
};

export type KpiTrendPlan = {
  scale: KpiTrendScale;
  /** The month the view is anchored on — the one the Month select shows. */
  month: string;
  /** "September 2026", "Q3 2026", "Semester 2 · 2026". */
  title: string;
  /** The pieces first, then the total. Empty when nothing in the view has begun. */
  columns: KpiTrendColumnPlan[];
  /** True while the last piece is still running — the total is then "so far", not a verdict. */
  running: boolean;
};

/** "1–7 Sep", from the one span-label writer (reps-plans.ts) rather than a second copy of it. */
function spanOf(month: string, from: string, to: string, todayIso: string): string {
  return repsPlansRange(month, todayIso, `${from}..${to}`).periodLabel;
}

function monthEndOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

function monthKeyOf(year: number, index: number): string {
  return `${year}-${String(index).padStart(2, "0")}`;
}

/**
 * Which columns the view shows, for the month on screen and today (Cairo). Pure — no database.
 *
 * ONLY WHAT HAS BEGUN IS SHOWN, which is the owner's own example: on the 22nd of September he sees
 * week 1, week 2, week 3 and the week that opened today, then the month through those weeks. A week
 * 5 that has not started would be a column of blanks, and a month total stretched over it would
 * divide by plan days nobody has reached. So the month total ends where the last begun week ends,
 * and becomes the plain whole month once every week has begun.
 */
export function kpiTrendPlan(scale: KpiTrendScale, month: string, todayIso: string): KpiTrendPlan {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7));

  if (scale === "month") {
    const weeks = repsPlansWeeks(month, todayIso);
    const begun = weeks.filter((week) => week.started);
    const title = monthLabelOf(month);
    if (begun.length === 0) return { scale, month, title, columns: [], running: false };
    const last = begun[begun.length - 1];
    const whole = begun.length === weeks.length;
    const columns: KpiTrendColumnPlan[] = begun.map((week, index) => ({
      key: week.key,
      kind: "week",
      label: `Week ${index + 1}`,
      span: spanOf(month, week.from, week.to, todayIso),
      month,
      period: week.key,
    }));
    columns.push({
      key: "total",
      kind: "total",
      label: "Month",
      span: spanOf(month, `${month}-01`, last.to, todayIso),
      month,
      // The whole month is the Summary tab's own default window; a partial month is the explicit
      // range repsPlansRange already parses, so the total is exactly what picking those dates shows.
      period: whole ? "month" : `${month}-01..${last.to}`,
    });
    return { scale, month, title, columns, running: todayIso <= last.to };
  }

  const firstIndex = scale === "quarter" ? Math.floor((monthIndex - 1) / 3) * 3 + 1 : monthIndex <= 6 ? 1 : 7;
  const count = scale === "quarter" ? 3 : 6;
  const ordinal = scale === "quarter" ? Math.floor((monthIndex - 1) / 3) + 1 : monthIndex <= 6 ? 1 : 2;
  const title = scale === "quarter" ? `Q${ordinal} ${year}` : `Semester ${ordinal} · ${year}`;
  const months: string[] = [];
  for (let index = firstIndex; index < firstIndex + count; index += 1) {
    const key = monthKeyOf(year, index);
    // Begun, and inside the CRM's own history — a month before the floor can only show empty rows.
    if (`${key}-01` <= todayIso && key >= CRM_DATA_FLOOR_MONTH) months.push(key);
  }
  if (months.length === 0) return { scale, month, title, columns: [], running: false };

  const columns: KpiTrendColumnPlan[] = months.map((key) => ({
    key,
    kind: "month",
    label: MONTH_SHORT[Number(key.slice(5, 7)) - 1] ?? key,
    span: spanOf(key, `${key}-01`, monthEndOf(key), todayIso),
    month: key,
    period: "month",
  }));
  const first = months[0];
  const last = months[months.length - 1];
  columns.push({
    key: "total",
    kind: "total",
    label: scale === "quarter" ? `Q${ordinal}` : `S${ordinal}`,
    span:
      first === last
        ? (MONTH_SHORT[Number(first.slice(5, 7)) - 1] ?? first)
        : `${MONTH_SHORT[Number(first.slice(5, 7)) - 1]} – ${MONTH_SHORT[Number(last.slice(5, 7)) - 1]}`,
    month: last,
    period: null,
  });
  return { scale, month, title, columns, running: todayIso <= monthEndOf(last) || months.length < count };
}

// ── The sums, and the cell each one prints ─────────────────────────────────────────────────────

/**
 * The counts one cell is made of — one rep in one column, a rep's months added up, or the team.
 *
 * Counts only, so any two of them add. Percentages are formed once, at the end, in `kpiTrendCell`.
 */
export type KpiTrendSums = {
  reps: number;
  /**
   * The working days the call rates divide by. RULING A1 (owner, 2026-09-21): a row with no GPS
   * feed has its calls AND its days left out together — exactly `sumKpiTeamTotals` in kpis-board.ts —
   * so the rest of the team is never divided by days whose calls could not be counted.
   */
  callDays: number;
  amVerified: number;
  pmVerified: number;
  pharmacyVerified: number;
  /** A counted row logged something. False reads "No calls", never a red 0%. */
  logged: boolean;
  /** Rows left out of the call rates under ruling A1. */
  noGpsFeedRows: number;
  plannedDoctors: number;
  visitedDoctors: number;
  onPlanDoctors: number;
  /**
   * What frequency divides by. The window's planned doctors under the old rules; under the Phoenix
   * rules the GRADED doctors only (rule 7) — the same base the board's own team frequency uses.
   */
  frequencyBase: number;
};

export const EMPTY_KPI_TREND_SUMS: KpiTrendSums = {
  reps: 0,
  callDays: 0,
  amVerified: 0,
  pmVerified: 0,
  pharmacyVerified: 0,
  logged: false,
  noGpsFeedRows: 0,
  plannedDoctors: 0,
  visitedDoctors: 0,
  onPlanDoctors: 0,
  frequencyBase: 0,
};

/** One rep's row in one column, as counts. */
export function kpiTrendSumsOfRow(row: KpiRepRow): KpiTrendSums {
  const counted = !row.noGpsFeed;
  return {
    reps: 1,
    callDays: counted ? row.workingDays : 0,
    amVerified: counted ? row.amVerified : 0,
    pmVerified: counted ? row.pmVerified : 0,
    pharmacyVerified: counted ? row.pharmacyVerified : 0,
    logged: counted && row.hasCallRate,
    noGpsFeedRows: counted ? 0 : 1,
    plannedDoctors: row.plannedDoctors,
    visitedDoctors: row.visitedDoctors,
    onPlanDoctors: row.onPlanDoctors,
    frequencyBase: row.phoenix ? row.phoenix.frequency.judged : row.plannedDoctors,
  };
}

export function addKpiTrendSums(left: KpiTrendSums, right: KpiTrendSums): KpiTrendSums {
  return {
    reps: left.reps + right.reps,
    callDays: left.callDays + right.callDays,
    amVerified: left.amVerified + right.amVerified,
    pmVerified: left.pmVerified + right.pmVerified,
    pharmacyVerified: left.pharmacyVerified + right.pharmacyVerified,
    logged: left.logged || right.logged,
    noGpsFeedRows: left.noGpsFeedRows + right.noGpsFeedRows,
    plannedDoctors: left.plannedDoctors + right.plannedDoctors,
    visitedDoctors: left.visitedDoctors + right.visitedDoctors,
    onPlanDoctors: left.onPlanDoctors + right.onPlanDoctors,
    frequencyBase: left.frequencyBase + right.frequencyBase,
  };
}

export function sumKpiTrend(parts: readonly KpiTrendSums[]): KpiTrendSums {
  return parts.reduce(addKpiTrendSums, EMPTY_KPI_TREND_SUMS);
}

/** One call rate in a cell. `attainmentPct` is null with no target (pharmacy) or nothing to divide. */
export type KpiTrendRate = {
  verified: number;
  rate: number | null;
  target: number | null;
  attainmentPct: number | null;
};

/** What one cell prints, for every measure — the view picks which one it shows. */
export type KpiTrendCell = {
  am: KpiTrendRate;
  pm: KpiTrendRate;
  pharmacy: KpiTrendRate;
  coverage: { visited: number; planned: number; pct: number | null };
  frequency: { met: number; base: number; pct: number | null };
  callDays: number;
  /** Something was logged in a counted row. False with call days = "No calls". */
  logged: boolean;
  /** Every row in the cell was left out under ruling A1 — "No GPS feed", never 0%. */
  noGpsFeed: boolean;
  noGpsFeedRows: number;
  reps: number;
};

const pctOrNull = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 100) : null;

function rateOf(verified: number, sums: KpiTrendSums, target: number | null): KpiTrendRate {
  const scored = sums.callDays > 0 && sums.logged;
  return {
    verified,
    rate: scored ? verified / sums.callDays : null,
    target,
    // The same formula `attainmentPct` in kpis-board.ts applies to one row: calls over what the target
    // asked for across the same working days. Formed from the SUMS, so a quarter is its calls over
    // its days — never an average of three monthly percentages.
    attainmentPct: scored && target != null && target > 0 ? Math.round((verified / (sums.callDays * target)) * 100) : null,
  };
}

/** The percentages, formed once from the counts. */
export function kpiTrendCell(sums: KpiTrendSums): KpiTrendCell {
  return {
    am: rateOf(sums.amVerified, sums, AM_CALL_RATE_TARGET),
    pm: rateOf(sums.pmVerified, sums, PM_CALL_RATE_TARGET),
    pharmacy: rateOf(sums.pharmacyVerified, sums, PHARMACY_CALL_RATE_TARGET),
    coverage: {
      visited: sums.visitedDoctors,
      planned: sums.plannedDoctors,
      pct: pctOrNull(sums.visitedDoctors, sums.plannedDoctors),
    },
    frequency: {
      met: sums.onPlanDoctors,
      base: sums.frequencyBase,
      pct: pctOrNull(sums.onPlanDoctors, sums.frequencyBase),
    },
    callDays: sums.callDays,
    logged: sums.logged,
    noGpsFeed: sums.reps > 0 && sums.noGpsFeedRows === sums.reps,
    noGpsFeedRows: sums.noGpsFeedRows,
    reps: sums.reps,
  };
}

// ── One rep's months, consolidated into one row ────────────────────────────────────────────────

/**
 * A rep's rows from several months folded into ONE `KpiRepRow`, so the quarter and semester views
 * can run the board's own filters and sort over it (`applyKpiFilters`) — "Behind on coverage this
 * quarter" is then the same band, cut the same way, as "Behind this month".
 *
 * Counts are added; every ratio is re-formed from the added counts, with `attainmentPct` — the
 * board's own formula, exported for this — for AM, PM and pharmacy apart. Ruling A1 holds per month:
 * a month with no GPS feed leaves its calls and its days out together, and the rep reads "No GPS
 * feed" for the whole span only when no other month logged anything.
 *
 * Identity (name, line, area, manager) is the LATEST month's — where he sits now. `phoenix` is
 * dropped: its daily follow-up describes one running month and has no meaning summed over three.
 */
export function consolidateKpiRows(rows: readonly KpiRepRow[]): KpiRepRow {
  if (rows.length === 0) throw new Error("consolidateKpiRows needs at least one row");
  const latest = rows[rows.length - 1];
  const counted = rows.filter((row) => !row.noGpsFeed);
  const add = (pick: (row: KpiRepRow) => number, from: readonly KpiRepRow[] = rows) =>
    from.reduce((total, row) => total + pick(row), 0);

  const workingDays = add((row) => row.workingDays, counted);
  const hasCallRate = counted.some((row) => row.hasCallRate);
  const perDay = (value: number) => (workingDays > 0 && hasCallRate ? value / workingDays : null);
  const amVerified = add((row) => row.amVerified, counted);
  const pmVerified = add((row) => row.pmVerified, counted);
  const pharmacyVerified = add((row) => row.pharmacyVerified, counted);
  const amReported = add((row) => row.amReported, counted);
  const pmReported = add((row) => row.pmReported, counted);
  const pharmacyReported = add((row) => row.pharmacyReported, counted);
  const totalCalls = add((row) => row.totalCalls);
  const campaignCalls = add((row) => row.campaignCalls);
  const plannedDoctors = add((row) => row.plannedDoctors);
  const visitedDoctors = add((row) => row.visitedDoctors);
  const onPlanDoctors = add((row) => row.onPlanDoctors);
  const frequencyBase = add((row) => (row.phoenix ? row.phoenix.frequency.judged : row.plannedDoctors));
  const hasMeasurablePlan = plannedDoctors > 0;
  const coveragePct = pctOrNull(visitedDoctors, plannedDoctors) ?? 0;

  const consolidated: KpiRepRow = {
    ...latest,
    workingDays,
    amVerified,
    pmVerified,
    amRate: perDay(amVerified),
    pmRate: perDay(pmVerified),
    amReported,
    pmReported,
    amReportedRate: perDay(amReported),
    pmReportedRate: perDay(pmReported),
    totalCalls,
    campaignCalls,
    campaignShare: totalCalls > 0 ? campaignCalls / totalCalls : 0,
    campaignOnlyDays: add((row) => row.campaignOnlyDays),
    hasCallRate,
    noGpsFeed: rows.some((row) => row.noGpsFeed) && !hasCallRate,
    amAttainmentPct: null,
    pmAttainmentPct: null,
    pharmacyVerified,
    pharmacyRate: perDay(pharmacyVerified),
    pharmacyReported,
    pharmacyReportedRate: perDay(pharmacyReported),
    pharmacyAttainmentPct: null,
    plannedDoctors,
    visitedDoctors,
    missedDoctors: add((row) => row.missedDoctors),
    coveragePct,
    meetsCoverageFloor: hasMeasurablePlan ? coveragePct >= COVERAGE_TARGET_FLOOR_PCT : null,
    onPlanDoctors,
    underDoctors: add((row) => row.underDoctors),
    overDoctors: add((row) => row.overDoctors),
    frequencyPct: pctOrNull(onPlanDoctors, frequencyBase) ?? 0,
    hasMeasurablePlan,
    plannedCalls: add((row) => row.plannedCalls),
    plannedCallsToDate: add((row) => row.plannedCallsToDate),
    actualCalls: add((row) => row.actualCalls),
    offPlanDoctors: add((row) => row.offPlanDoctors),
    plannedAccounts: add((row) => row.plannedAccounts),
    gradeA: add((row) => row.gradeA),
    gradeB: add((row) => row.gradeB),
    gradeC: add((row) => row.gradeC),
    underPlannedVsGrade: add((row) => row.underPlannedVsGrade),
    phoenix: null,
  };
  consolidated.amAttainmentPct = attainmentPct(consolidated, amVerified, AM_CALL_RATE_TARGET);
  consolidated.pmAttainmentPct = attainmentPct(consolidated, pmVerified, PM_CALL_RATE_TARGET);
  consolidated.pharmacyAttainmentPct = attainmentPct(consolidated, pharmacyVerified, PHARMACY_CALL_RATE_TARGET);
  return consolidated;
}

// ── The whole view ─────────────────────────────────────────────────────────────────────────────

/** One column as the view prints it: the plan, plus what its board said about its own window. */
export type KpiTrendColumn = KpiTrendColumnPlan & {
  /** Sat–Wed days the call rates divided by — through yesterday while the window runs (ruling C1). */
  callDays: number;
  /** The window opened today: its call-rate window is empty until today is over. */
  beganToday: boolean;
  /** Which rules scored it. The quarter total is "mixed" when its months disagree. */
  rules: "legacy" | "phoenix" | "mixed";
};

export type KpiTrendRepLine = {
  key: string;
  repName: string;
  lineName: string | null;
  areaName: string | null;
  jobTitle: string | null;
  /** `employees.hire_date`, `YYYY-MM-DD` — printed beside his name. */
  hireDate: string | null;
  /** One cell per column, in column order. Null when he is not on that column's board at all. */
  cells: Array<KpiTrendCell | null>;
};

export type KpiTrend = {
  plan: KpiTrendPlan;
  columns: KpiTrendColumn[];
  /** The team: the reps in `reps`, added up per column. */
  team: KpiTrendCell[];
  reps: KpiTrendRepLine[];
  /**
   * The board the page header, the filters and the Month select read. Month by week: the month total's
   * own board. Quarter and semester: the month on screen. Its `filters` are the ones in the URL and its
   * `reps` are the reps this view lists, so the filter bar's "12 of 73" describes this table.
   */
  anchor: KpisBoard;
  /** Set when the columns were scored under two different rule sets (the CRM cutover fell inside). */
  rulesNote: string | null;
};

/** The facet filters alone — who a rep is. The band and flag filters describe a PERIOD's score. */
function identityFilters(filters: KpiFilterState): KpiFilterState {
  return { ...filters, coverage: [], frequency: [], amRate: [], pmRate: [], flags: [], ranges: {} };
}

/**
 * The key a rep is matched by across columns: his hr id, and failing that his CRM id, and failing
 * both his name. The CRM id is translated to the hr id wherever any column resolved one, so a rep whose
 * id resolved in August and not in July is still ONE line.
 */
function repKeyer(boards: readonly KpisBoard[]) {
  const hrByCrm = new Map<number, string>();
  for (const board of boards) {
    for (const row of board.reps) {
      if (row.agentCrmId != null && row.agentHrId) hrByCrm.set(row.agentCrmId, row.agentHrId);
    }
  }
  return (row: KpiRepRow): string => {
    const hrId = row.agentHrId ?? (row.agentCrmId != null ? hrByCrm.get(row.agentCrmId) : undefined);
    if (hrId) return `hr:${hrId}`;
    if (row.agentCrmId != null) return `crm:${row.agentCrmId}`;
    return `name:${row.repName.trim().toLowerCase()}`;
  };
}

/** How many boards are built at once. Each is five reads; six at a time would crowd the pool. */
const BOARD_CONCURRENCY = 3;

/** Builds the Weekly tab for one viewer. */
export async function getKpisTrend(input: {
  access: AccessContext;
  scale: KpiTrendScale;
  month: string;
  todayIso: string;
  filters?: KpiFilterState;
}): Promise<KpiTrend> {
  const filters = input.filters ?? EMPTY_KPI_FILTERS;
  const plan = kpiTrendPlan(input.scale, input.month, input.todayIso);
  const boardColumns = plan.columns.filter((column) => column.period != null);

  // Nothing has begun: the anchor is the month's own board, which already says so in its own words.
  if (boardColumns.length === 0) {
    const anchor = await getKpisBoard({
      access: input.access,
      month: input.month,
      todayIso: input.todayIso,
      filters,
      includeReports: false,
    });
    return { plan, columns: [], team: [], reps: [], anchor, rulesNote: null };
  }

  // Every board is built with the IDENTITY filters only. A band filter ("Behind on coverage") is a
  // verdict on the consolidated span and is applied to it below — applied per week, it would blank a
  // rep's good weeks out of the very row that shows he recovered.
  const boards = await mapWithConcurrency(boardColumns, BOARD_CONCURRENCY, (column) =>
    getKpisBoard({
      access: input.access,
      month: column.month,
      period: column.period,
      todayIso: input.todayIso,
      filters: identityFilters(filters),
      includeReports: false,
    }),
  );
  const boardByKey = new Map(boardColumns.map((column, index) => [column.key, boards[index]]));
  const keyOf = repKeyer(boards);

  const rowsByColumn = new Map<string, Map<string, KpiRepRow>>();
  for (const column of boardColumns) {
    const byRep = new Map<string, KpiRepRow>();
    for (const row of boardByKey.get(column.key)?.reps ?? []) byRep.set(keyOf(row), row);
    rowsByColumn.set(column.key, byRep);
  }

  const pieces = plan.columns.filter((column) => column.kind !== "total");
  const totalColumn = plan.columns[plan.columns.length - 1];
  const totalIsBoard = totalColumn.period != null;

  // THE REP LIST is decided on the TOTAL, with every filter in the URL applied to it — so the rows are
  // exactly the reps the Summary tab would list for the same span, in the same order.
  let totalRows: KpiRepRow[];
  if (totalIsBoard) {
    totalRows = applyKpiFilters(boardByKey.get(totalColumn.key)?.reps ?? [], filters);
  } else {
    const monthsByRep = new Map<string, KpiRepRow[]>();
    for (const column of pieces) {
      for (const [key, row] of rowsByColumn.get(column.key) ?? []) {
        const list = monthsByRep.get(key) ?? [];
        list.push(row);
        monthsByRep.set(key, list);
      }
    }
    totalRows = applyKpiFilters(
      [...monthsByRep.values()].map((rows) => consolidateKpiRows(rows)),
      filters,
    );
  }

  const reps: KpiTrendRepLine[] = totalRows.map((totalRow) => {
    const key = keyOf(totalRow);
    const pieceCells = pieces.map((column) => {
      const row = rowsByColumn.get(column.key)?.get(key);
      return row ? kpiTrendCell(kpiTrendSumsOfRow(row)) : null;
    });
    const totalSums = totalIsBoard
      ? kpiTrendSumsOfRow(totalRow)
      : sumKpiTrend(
          pieces.flatMap((column) => {
            const row = rowsByColumn.get(column.key)?.get(key);
            return row ? [kpiTrendSumsOfRow(row)] : [];
          }),
        );
    return {
      key,
      repName: totalRow.repName,
      lineName: totalRow.lineName,
      areaName: totalRow.areaName,
      jobTitle: totalRow.jobTitle,
      hireDate: totalRow.hireDate ?? null,
      cells: [...pieceCells, kpiTrendCell(totalSums)],
    };
  });

  // THE TEAM ROW adds up the reps on screen, column by column — never a board's own totals, which
  // would count reps a band filter has taken off this table. With no band filter the two are the
  // same numbers, because a board's totals are exactly its rows added up (`sumKpiTeamTotals`).
  const shownKeys = new Set(reps.map((line) => line.key));
  const pieceTeam = pieces.map((column) =>
    sumKpiTrend(
      [...(rowsByColumn.get(column.key) ?? new Map<string, KpiRepRow>()).entries()]
        .filter(([key]) => shownKeys.has(key))
        .map(([, row]) => kpiTrendSumsOfRow(row)),
    ),
  );
  const totalTeam = totalIsBoard
    ? sumKpiTrend(totalRows.map((row) => kpiTrendSumsOfRow(row)))
    : sumKpiTrend(pieceTeam);
  const team = [...pieceTeam, totalTeam].map((sums) => kpiTrendCell(sums));

  const rulesOf = (board: KpisBoard | undefined): "legacy" | "phoenix" => board?.kpiRules ?? "legacy";
  const pieceRules = pieces.map((column) => rulesOf(boardByKey.get(column.key)));
  const mixed = new Set(pieceRules).size > 1;
  const columns: KpiTrendColumn[] = plan.columns.map((column) => {
    const board = boardByKey.get(column.key);
    if (board) {
      return {
        ...column,
        callDays: board.workingDays,
        beganToday: board.range.todayLeftOut && board.range.dateTo < board.range.dateFrom,
        rules: rulesOf(board),
      };
    }
    // The quarter or semester total: its months' days added, as its call rate divides by them.
    const days = pieces.reduce((total, piece) => total + (boardByKey.get(piece.key)?.workingDays ?? 0), 0);
    return { ...column, callDays: days, beganToday: false, rules: mixed ? "mixed" : (pieceRules[0] ?? "legacy") };
  });

  // THE ANCHOR carries the page header. Its reps are the ones listed here, so the filter bar's count
  // and the empty state describe this table rather than a board nobody is looking at.
  const anchorBoard = totalIsBoard
    ? boardByKey.get(totalColumn.key)
    : (boardByKey.get(input.month) ?? boards[boards.length - 1]);
  const anchor: KpisBoard = {
    ...(anchorBoard as KpisBoard),
    filters,
    reps: totalRows,
    noGpsFeedShown: totalRows.filter((row) => row.noGpsFeed).length,
  };

  const rulesNote = mixed
    ? `The CRM cutover falls inside this ${plan.scale === "month" ? "month" : plan.scale}: ${pieces
        .map((column, index) => `${column.label} is scored on the ${pieceRules[index] === "phoenix" ? "Phoenix" : "old"} rules`)
        .join(", ")}. The total adds each piece as it was scored.`
    : (anchor.kpiRulesNote ?? null);

  return { plan, columns, team, reps, anchor, rulesNote };
}
