/**
 * Rep Coverage & Frequency, month over month.
 *
 * The month board (`rep-doctor-lists.ts`) answers "how is this rep doing NOW". This answers the
 * owner's follow-up: compare from January and record the changes. Same two KPIs, one row per rep
 * per month, plus the company line.
 *
 * WHY THIS RE-USES THE MONTH BOARD INSTEAD OF ITS OWN AGGREGATION. Every number here comes from
 * `buildRepDoctorListsBoard`, called once per month with that month's rows. A second fold — even a
 * "simple" SQL group-by — would be a second definition of coverage and frequency, and the two would
 * drift the first time either rule changed. A trend line that disagrees with the board it sits under
 * is worse than no trend line, because it is the one people screenshot. The shared context the fold
 * needs (employee directory, departed agents, grade norms) is fetched ONCE and handed to all months.
 *
 * WHAT THE HISTORY ACTUALLY CONTAINS (production, verified 2026-08-21):
 *
 *   month     plan rows   agents   rep-doctor pairs
 *   2026-01      16,411       58              5,197
 *   2026-02      14,218       84              5,724
 *   2026-03      17,506       83              7,817
 *   2026-04      20,690       82              8,209
 *   2026-05      20,778       83              8,749
 *   2026-06      24,678       83              9,376
 *   2026-07      22,863       82              9,173
 *   2026-08      18,645       78              9,163
 *
 * **January carries only 58 agents against 82–84 in every later month.** That is a property of what
 * the vendor still serves that far back, NOT a smaller field force — so a January company average is
 * computed over a different population and must never be read as "coverage improved since January".
 * `sparseAgentCoverage` flags it on the point itself rather than leaving the chart to imply it.
 *
 * The plan mirror before August exists only because it was backfilled on 2026-08-21 by replaying
 * `syncIReports360WeeklyPlans` month by month; `plan-sync.ts` upserts and never deletes, so that was
 * safe and is repeatable. The visits side has always been complete for this range.
 */
import { unstable_cache } from "next/cache";

import {
  DEFAULT_DOCTOR_COVERAGE_NORMS,
  getDoctorCoverageConfig,
} from "@/lib/crm/doctor-coverage-config";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getEffectiveExcludedAgentCrmIds, queryVisits } from "@/lib/crm/reads";
import {
  buildRepDoctorListsBoard,
  monthBounds,
  monthKeyOfDate,
  monthLabelOf,
  scanPlanEntries,
  type RepDoctorListsBoard,
  type VisitRow,
} from "@/lib/crm/rep-doctor-lists";
import { CAMPAIGN_TYPE } from "@/lib/crm/visit-types";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";

/** The first month the plan mirror holds. Earlier months return no plan rows at all, which would
 * render as a truthful-looking 0% for every rep — so the range is clamped here rather than left to
 * whatever a caller types. */
export const REP_DOCTOR_TREND_FIRST_MONTH = "2026-01";

/** A month whose measurable population falls below this share of the range's largest is marked
 * `sparseAgentCoverage` — its company average is computed over a materially different group and is
 * not comparable with the range's later months. */
const SPARSE_POPULATION_RATIO = 0.85;

/** Hard cap on how many months one call may scan. Each month costs two round trips to Frankfurt, so
 * an unbounded range is a slow page, not a wrong one — but slow is enough to guard against. */
export const REP_DOCTOR_TREND_MAX_MONTHS = 24;

/** How many months are read at once. The reads are independent, but this box has 16 GB and several
 * sessions on it, and eight simultaneous multi-thousand-row payloads is the kind of thing that
 * turns a slow page into a failed one. */
const MONTH_FETCH_CONCURRENCY = 3;

/** One rep in one month, or the company in one month. */
export type RepDoctorTrendPoint = {
  /** The last day scored in this month — the month's own end for a complete month, today for the
   * live one. Printed beside a partial month so its percentages are never read as full-month. */
  asOf: string;
  /** KPI 1: planned doctors reached at all. */
  coveragePct: number;
  /** Change in `coveragePct` against this series' PREVIOUS point, or null at the start of the
   * series. Against the previous point rather than the previous calendar month, because a rep with
   * no plan in April should be compared March-to-May, not told he fell 100 points and recovered. */
  coverageDelta: number | null;
  /** The frequency denominator: planned doctors minus those not yet due. Carried on the point so a
   * cohort line can be re-aggregated from summed counts rather than by averaging percentages. */
  dueDoctors: number;
  /** KPI 2: planned doctors whose call count matched the plan exactly, to date. */
  frequencyPct: number;
  frequencyDelta: number | null;
  /** True while the month is still running — its percentages are to-date, not final. */
  isPartialMonth: boolean;
  /** Change in list SIZE against the previous point. The owner's own framing: the doctor list "may
   * have addition or deletion" but should stay inside a band, so the movement is the finding. */
  listDelta: number | null;
  /** Reps who had a plan this month. On a company point this is the population the percentages are
   * computed over; on a rep point it is always 1, and only there to keep one shape. */
  measuredReps: number;
  month: string;
  monthLabel: string;
  onPlanDoctors: number;
  /** The doctor list itself — distinct SP contacts planned this month. */
  plannedDoctors: number;
  /** True when this month's plan mirror holds far fewer agents than its neighbours, so a company
   * average over it is not comparable. Always false on a rep series — it is a population fact. */
  sparseAgentCoverage: boolean;
  visitedDoctors: number;
};

export type RepDoctorTrendRepSeries = {
  agentCrmId: number;
  agentHrId: string | null;
  /** One entry per month in `months`, aligned by index. `null` means this rep had NO plan that
   * month — not zero coverage. Rendering it as 0 would accuse a rep of a month he was not measured
   * in, which is the single easiest way for this board to be quietly libellous. */
  cells: Array<RepDoctorTrendPoint | null>;
  /** The most recent month with a plan, for sorting and for the summary column. */
  latest: RepDoctorTrendPoint | null;
  /** Coverage change from this rep's FIRST measured month to his latest. Null when he has fewer
   * than two measured months. */
  coverageChange: number | null;
  frequencyChange: number | null;
  /** Months in the range where this rep had a plan at all. */
  measuredMonths: number;
  repKey: string;
  repName: string;
};

export type RepDoctorTrend = {
  /** Company-wide point per month, aligned with `months`. Every rep measured in that month, which
   * is NOT the same population from month to month — see `likeForLike`. */
  company: RepDoctorTrendPoint[];
  from: string;
  /**
   * The honest comparison: the same reps in every month of the range, aggregated from their summed
   * counts. Aligned with `months`, and empty when no rep spans the whole range.
   *
   * WHY THIS EXISTS. The company line above changes population as it goes. Measured in production
   * 2026-08-21, the plan mirror holds 58 agents in January and 78 in August, but **32 of January's
   * carry a NULL `agent_hr_id`** — the marker for a rep who has since left (`employees.crm_id` is
   * cleared on exit) — against 8 in August, and only 27 of January's agents still plan in August.
   * The board correctly drops departed agents, so an early month is scored over the survivors only.
   * Reading the resulting rise as "coverage improved" would credit today's field force with a
   * change that is mostly who is left in the data. This line removes that effect entirely.
   */
  likeForLike: RepDoctorTrendPoint[];
  /** How many reps the `likeForLike` cohort contains. */
  likeForLikeReps: number;
  /** Month keys ascending — the x axis. */
  months: string[];
  reps: RepDoctorTrendRepSeries[];
  to: string;
};

/** Month key arithmetic, string-only. Never a `Date`: these are Cairo wall-clock month labels, and
 * the moment one becomes an instant it acquires a timezone it never had. */
export function nextMonthKey(monthKey: string): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  if (month >= 12) return `${year + 1}-01`;
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** Every month key from `from` to `to` inclusive, clamped to the range the mirror can answer for and
 * to `REP_DOCTOR_TREND_MAX_MONTHS`. Returns [] when the range is inverted. */
export function monthKeysBetween(from: string, to: string): string[] {
  const start = from < REP_DOCTOR_TREND_FIRST_MONTH ? REP_DOCTOR_TREND_FIRST_MONTH : from;
  if (start > to) return [];
  const months: string[] = [];
  let cursor = start;
  while (cursor <= to && months.length < REP_DOCTOR_TREND_MAX_MONTHS) {
    months.push(cursor);
    cursor = nextMonthKey(cursor);
  }
  return months;
}

/**
 * Stitches per-month boards into the series. Pure — the boards are the only input, so the trend can
 * be tested against fixtures without a database, exactly like the board itself.
 *
 * Boards must arrive in ascending month order; the caller sorts them.
 */
export function stitchRepDoctorTrend(boards: readonly RepDoctorListsBoard[]): RepDoctorTrend {
  const months = boards.map((board) => board.month);

  const company: RepDoctorTrendPoint[] = [];
  for (const board of boards) {
    const totals = board.totals;
    const previous = company.length > 0 ? company[company.length - 1] : null;
    // Reps WITH A PLAN, not `totals.reps` — that one counts anybody with activity, including reps
    // who only ever appear on the visits side, so it stays near 80 even in a month whose plan mirror
    // holds 58 agents and would hide the very sparseness this flag exists to show.
    const measuredReps = board.reps.filter((rep) => rep.hasMeasurablePlan).length;
    company.push({
      asOf: board.asOf,
      coverageDelta: previous ? totals.coveragePct - previous.coveragePct : null,
      coveragePct: totals.coveragePct,
      dueDoctors: totals.plannedDoctors - totals.notDueDoctors,
      frequencyDelta: previous ? totals.frequencyPct - previous.frequencyPct : null,
      frequencyPct: totals.frequencyPct,
      isPartialMonth: board.asOf < monthBounds(board.month).to,
      listDelta: previous ? totals.plannedDoctors - previous.plannedDoctors : null,
      measuredReps,
      month: board.month,
      monthLabel: board.monthLabel,
      onPlanDoctors: totals.onPlanDoctors,
      plannedDoctors: totals.plannedDoctors,
      // Filled in below, once the whole series is known — sparseness is relative to the range.
      sparseAgentCoverage: false,
      visitedDoctors: totals.visitedDoctors,
    });
  }

  // A month is "sparse" RELATIVE to the range, not against a fixed headcount. An absolute threshold
  // was tried first and fired on all eight months, because the measurable population (reps with a
  // plan, still employed) runs 33→69 across this range rather than tracking the 58→84 agent counts
  // in the raw mirror. What matters is only whether this month's population is far enough below the
  // range's best that its company average is not comparable with it.
  const maxMeasuredReps = company.reduce((max, point) => Math.max(max, point.measuredReps), 0);
  const sparseFloor = Math.round(maxMeasuredReps * SPARSE_POPULATION_RATIO);
  for (const point of company) {
    point.sparseAgentCoverage = point.measuredReps > 0 && point.measuredReps < sparseFloor;
  }

  // Rep identity is keyed on repKey — the same canonical key the month board sorts and filters on,
  // so a rep whose CRM id was reused mid-range still lines up as one row. Name and ids are taken
  // from the LATEST month that has him, because that is the current truth about who he is.
  const seriesByRepKey = new Map<string, RepDoctorTrendRepSeries>();
  const monthCount = boards.length;

  boards.forEach((board, monthIndex) => {
    const monthEnd = monthBounds(board.month).to;
    const isPartialMonth = board.asOf < monthEnd;

    for (const rep of board.reps) {
      // No plan means nothing to be a percentage of. The month board already decides this; reusing
      // its flag keeps "measurable" defined in exactly one place.
      if (!rep.hasMeasurablePlan) continue;

      let series = seriesByRepKey.get(rep.repKey);
      if (!series) {
        series = {
          agentCrmId: rep.agentCrmId,
          agentHrId: rep.agentHrId,
          cells: Array.from({ length: monthCount }, () => null),
          coverageChange: null,
          frequencyChange: null,
          latest: null,
          measuredMonths: 0,
          repKey: rep.repKey,
          repName: rep.repName,
        };
        seriesByRepKey.set(rep.repKey, series);
      }
      series.agentCrmId = rep.agentCrmId;
      series.agentHrId = rep.agentHrId;
      series.repName = rep.repName;

      const previous = series.latest;
      const point: RepDoctorTrendPoint = {
        asOf: board.asOf,
        coverageDelta: previous ? rep.coveragePct - previous.coveragePct : null,
        coveragePct: rep.coveragePct,
        dueDoctors: rep.plannedDoctors - rep.notDueDoctors,
        frequencyDelta: previous ? rep.frequencyPct - previous.frequencyPct : null,
        frequencyPct: rep.frequencyPct,
        isPartialMonth,
        listDelta: previous ? rep.plannedDoctors - previous.plannedDoctors : null,
        measuredReps: 1,
        month: board.month,
        monthLabel: board.monthLabel,
        onPlanDoctors: rep.onPlanDoctors,
        plannedDoctors: rep.plannedDoctors,
        // A population fact about the company month, not about one rep — a rep either has a plan
        // that month or has no cell at all, so there is nothing sparse to flag on his own row.
        sparseAgentCoverage: false,
        visitedDoctors: rep.visitedDoctors,
      };
      series.cells[monthIndex] = point;
      series.latest = point;
      series.measuredMonths += 1;
    }
  });

  const reps = Array.from(seriesByRepKey.values());
  for (const series of reps) {
    const measured = series.cells.filter((cell): cell is RepDoctorTrendPoint => cell !== null);
    if (measured.length >= 2) {
      const first = measured[0];
      const last = measured[measured.length - 1];
      series.coverageChange = last.coveragePct - first.coveragePct;
      series.frequencyChange = last.frequencyPct - first.frequencyPct;
    }
  }

  // Biggest coverage FALL first — the whole point of a trend is to find who is sliding. Reps with
  // only one measured month have no change to rank on and sort after everyone who does.
  reps.sort((a, b) => {
    const changeA = a.coverageChange;
    const changeB = b.coverageChange;
    if (changeA === null && changeB === null) return a.repName.localeCompare(b.repName);
    if (changeA === null) return 1;
    if (changeB === null) return -1;
    if (changeA !== changeB) return changeA - changeB;
    return a.repName.localeCompare(b.repName);
  });

  // The like-for-like cohort: reps with a measured cell in EVERY month of the range. Aggregated
  // from summed COUNTS, never by averaging the reps' percentages — a rep with 21 doctors and one
  // with 234 both exist here (measured 2026-08-21), and averaging would weigh them equally.
  const cohort = reps.filter((series) => series.cells.every((cell) => cell !== null));
  const likeForLike: RepDoctorTrendPoint[] = [];
  if (cohort.length > 0) {
    months.forEach((month, monthIndex) => {
      let dueDoctors = 0;
      let onPlanDoctors = 0;
      let plannedDoctors = 0;
      let visitedDoctors = 0;
      for (const series of cohort) {
        const cell = series.cells[monthIndex];
        if (!cell) continue;
        dueDoctors += cell.dueDoctors;
        onPlanDoctors += cell.onPlanDoctors;
        plannedDoctors += cell.plannedDoctors;
        visitedDoctors += cell.visitedDoctors;
      }
      const coveragePct = plannedDoctors > 0 ? Math.round((visitedDoctors / plannedDoctors) * 100) : 0;
      const frequencyPct = dueDoctors > 0 ? Math.round((onPlanDoctors / dueDoctors) * 100) : 0;
      const previous = likeForLike.length > 0 ? likeForLike[likeForLike.length - 1] : null;
      const companyPoint = company[monthIndex];
      likeForLike.push({
        asOf: companyPoint.asOf,
        coverageDelta: previous ? coveragePct - previous.coveragePct : null,
        coveragePct,
        dueDoctors,
        frequencyDelta: previous ? frequencyPct - previous.frequencyPct : null,
        frequencyPct,
        isPartialMonth: companyPoint.isPartialMonth,
        listDelta: previous ? plannedDoctors - previous.plannedDoctors : null,
        measuredReps: cohort.length,
        month,
        monthLabel: companyPoint.monthLabel,
        onPlanDoctors,
        plannedDoctors,
        // The cohort is the same size in every month by construction — that is the whole point.
        sparseAgentCoverage: false,
        visitedDoctors,
      });
    });
  }

  return {
    company,
    from: months[0] ?? "",
    likeForLike,
    likeForLikeReps: cohort.length,
    months,
    reps,
    to: months[months.length - 1] ?? "",
  };
}

/** Reads one month's two halves and folds them with the shared context. */
async function buildMonth(
  month: string,
  context: {
    employeeNameByHrId: ReadonlyMap<string, string>;
    excludedAgentCrmIds: readonly number[];
    norms: Awaited<ReturnType<typeof getDoctorCoverageConfig>>["norms"];
  },
): Promise<RepDoctorListsBoard> {
  const { from, to } = monthBounds(month);
  const [planRows, visitRows] = await Promise.all([
    scanPlanEntries(from, to),
    queryVisits<VisitRow>({
      collapseDoubleVisits: true,
      columns:
        "agent_crm_id, agent_hr_id, agent_name, contact_crm_id, crm_contact_grade, speciality, visit_date, visit_type",
      dateFrom: from,
      dateTo: to,
      visitTypes: [0, CAMPAIGN_TYPE],
    }),
  ]);
  return buildRepDoctorListsBoard({
    employeeNameByHrId: context.employeeNameByHrId,
    excludedAgentCrmIds: context.excludedAgentCrmIds,
    month,
    norms: context.norms,
    planRows,
    visitRows,
  });
}

async function loadRepDoctorTrend(from: string, to: string): Promise<RepDoctorTrend> {
  const months = monthKeysBetween(from, to);
  if (months.length === 0) {
    return { company: [], from, likeForLike: [], likeForLikeReps: 0, months: [], reps: [], to };
  }

  const [excludedAgentCrmIds, directory, norms] = await Promise.all([
    getEffectiveExcludedAgentCrmIds(),
    getEmployeeDirectoryRows({ includeInactive: true }),
    getDoctorCoverageConfig()
      .then((config) => config.norms)
      .catch(() => DEFAULT_DOCTOR_COVERAGE_NORMS),
  ]);

  const employeeNameByHrId = new Map<string, string>();
  for (const employee of directory) {
    employeeNameByHrId.set(employee.hrId.trim().toUpperCase(), employee.displayName || employee.fullName);
  }
  const context = { employeeNameByHrId, excludedAgentCrmIds, norms };

  // Bounded concurrency, preserving month order in the output regardless of completion order.
  const boards: RepDoctorListsBoard[] = new Array(months.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MONTH_FETCH_CONCURRENCY, months.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= months.length) return;
      boards[index] = await buildMonth(months[index], context);
    }
  });
  await Promise.all(workers);

  return stitchRepDoctorTrend(boards);
}

const loadRepDoctorTrendCached = unstable_cache(loadRepDoctorTrend, ["crm-rep-doctor-trend"], {
  // The plan mirror only moves on an explicit admin sync and the visits mirror on the nightly one,
  // so a five-minute window costs nothing and keeps eight months of scanning off every page load.
  revalidate: 300,
  tags: ["crm-rep-doctor-lists"],
});

/**
 * The month-over-month series for both KPIs.
 *
 * Defaults to January 2026 (the first month the mirror holds) through the current Cairo month, which
 * is the comparison the owner asked for.
 */
export async function getRepDoctorTrend(input?: {
  from?: string;
  to?: string;
}): Promise<RepDoctorTrend> {
  const from = input?.from ?? REP_DOCTOR_TREND_FIRST_MONTH;
  const to = input?.to ?? monthKeyOfDate(cairoTodayIso());
  return loadRepDoctorTrendCached(from, to);
}

/** Re-exported so a caller can label a month without importing the board module too. */
export { monthLabelOf };
