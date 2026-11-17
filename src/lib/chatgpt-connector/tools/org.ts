/**
 * The field KPIs board and the organogram — each through the service and gate its screen uses.
 */
import { z } from "zod";

import { canAccess } from "@/lib/auth/permissions";
import { cairoTodayIso } from "@/lib/crm/dates";
import { canSeeDoctorCoverage } from "@/lib/crm/doctor-coverage-roles";
import { getKpisBoard } from "@/lib/crm/kpis-board";
import { KPI_FILTER_PARAMS, parseKpiFilters } from "@/lib/crm/kpis-filters";
import { resolveRepsPlansMonth } from "@/lib/crm/reps-plans";
import { canAccessCompanyOrganogram, getOrganogramReport, resolveOrganogramLinesForEmployee } from "@/lib/reports/organogram";
import { capRows, cappedNote, monthLabel, parsePeriod, pickFields } from "@/lib/chatgpt-connector/tools/helpers";
import { defineTool, ToolRefusal } from "@/lib/chatgpt-connector/types";

const KPI_REP_FIELDS = [
  "agentHrId",
  "repName",
  "jobTitle",
  "lineName",
  "regionName",
  "areaName",
  "managerName",
  "hireDate",
  "justStarted",
  "workingDays",
  "amVerified",
  "pmVerified",
  "amRate",
  "pmRate",
  "amAttainmentPct",
  "pmAttainmentPct",
  "amReported",
  "pmReported",
  "pharmacyVerified",
  "pharmacyRate",
  "totalCalls",
  "campaignCalls",
  "noGpsFeed",
  "plannedDoctors",
  "visitedDoctors",
  "missedDoctors",
  "coveragePct",
  "meetsCoverageFloor",
  "onPlanDoctors",
  "underDoctors",
  "overDoctors",
  "frequencyPct",
  "hasMeasurablePlan",
] as const;

const KPI_MANAGER_FIELDS = [
  "name",
  "jobTitle",
  "level",
  "lineName",
  "regionName",
  "areaName",
  "reportsTo",
  "repsBeneath",
  "coveragePct",
  "frequencyPct",
  "amAttainmentPct",
  "pmAttainmentPct",
  "amRate",
  "pmRate",
  "pharmacyRate",
  "overallPct",
] as const;

function pct(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "no figure" : `${Math.round(value * 10) / 10}%`;
}

function rate(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "no figure" : `${Math.round(value * 10) / 10} a day`;
}

export const crmKpisTool = defineTool({
  name: "phoenix_crm_kpis",
  title: "Field KPIs",
  description:
    "The KPIs board for the field force (Phoenix CRM): per medical rep and per manager — AM and PM call rate (verified calls per working day, " +
    "never combined), attainment against the AM and PM targets, pharmacy calls, doctor coverage % (doctors visited of doctors planned, 95% floor) " +
    "and frequency %, plus the team totals and the consolidated KPI index with its arithmetic. month = YYYY-MM (default this month); " +
    "period = 'month' (default), a week key 'w1'…'w5', or 'YYYY-MM-DD..YYYY-MM-DD' inside the month. Optional filters: line, region, area, manager (names) and query (a rep's name).",
  input: {
    month: z.string().optional().describe("YYYY-MM."),
    period: z.string().max(40).optional(),
    line: z.string().max(60).optional(),
    region: z.string().max(80).optional(),
    area: z.string().max(80).optional(),
    manager: z.string().max(120).optional().describe("A manager's name — reps anywhere beneath them."),
    query: z.string().max(120).optional().describe("A rep's name."),
  },
  run: async (ctx, input) => {
    // app/(admin)/admin/kpis/page.tsx: the role list, then crm_visits:read; the board scopes every row.
    if (!canSeeDoctorCoverage(ctx.role) || !(await canAccess(ctx, "crm_visits", "read"))) {
      throw new ToolRefusal("Your role does not see the KPIs board.");
    }
    if (input.month && !parsePeriod(input.month)) throw new ToolRefusal("month must be written YYYY-MM.");
    const today = cairoTodayIso();
    const month = resolveRepsPlansMonth(input.month, today);
    const params: Record<string, string | undefined> = {
      [KPI_FILTER_PARAMS.lines]: input.line,
      [KPI_FILTER_PARAMS.regions]: input.region,
      [KPI_FILTER_PARAMS.areas]: input.area,
      [KPI_FILTER_PARAMS.managers]: input.manager,
      [KPI_FILTER_PARAMS.query]: input.query,
    };
    const board = await getKpisBoard({
      access: ctx,
      month,
      period: input.period ?? null,
      todayIso: today,
      filters: parseKpiFilters(params),
    });
    if (board.scopeReason) throw new ToolRefusal(board.scopeReason);
    const reps = capRows(board.reps);
    const managers = capRows(board.managers);
    const t = board.totals;
    return {
      summary:
        `KPIs, ${board.monthLabel || monthLabel(month)} (${board.range.dateFrom} to ${board.range.dateTo}, ${board.workingDays} working days), ` +
        `${t.reps} of ${board.scopedReps} reps: AM ${rate(t.amRate)} (${pct(t.amAttainmentPct)} of target), PM ${rate(t.pmRate)} (${pct(t.pmAttainmentPct)} of target), ` +
        `coverage ${pct(t.coveragePct)} (${t.visitedDoctors} of ${t.plannedDoctors} planned doctors), frequency ${pct(t.frequencyPct)}, ` +
        `overall KPI ${pct(board.kpiIndex.overallPct)}.` +
        (board.holidaysComplete ? "" : " The holiday calendar could not be read, so call rates may read low.") +
        cappedNote(reps.total, reps.rows.length),
      data: {
        month,
        range: board.range,
        workingDays: board.workingDays,
        workingDaysInWindow: board.workingDaysInWindow,
        asOf: board.asOf,
        scope: board.scopeLabel,
        totals: board.totals,
        kpiIndex: board.kpiIndex,
        targets: { am: board.amTarget, pm: board.pmTarget, coverageFloorPct: board.coverageFloorPct },
        reps: reps.rows.map((row) => pickFields(row, KPI_REP_FIELDS)),
        repsTotal: reps.total,
        repsCapped: reps.capped,
        managers: managers.rows.map((row) => pickFields(row, KPI_MANAGER_FIELDS)),
      },
    };
  },
});

const ORG_ROW_FIELDS = [
  "type",
  "hrId",
  "displayName",
  "nameAr",
  "jobTitle",
  "positionTitle",
  "departmentName",
  "lineName",
  "regionName",
  "areaName",
  "teamName",
  "managerName",
  "status",
  "employmentStatus",
  "hireDate",
  "startsOn",
  "vacancyCode",
] as const;

/** Count rows by a label, largest first. */
function countBy<T>(rows: readonly T[], labelOf: (row: T) => string | null | undefined): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = labelOf(row)?.trim() || "Not recorded";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export const orgChartTool = defineTool({
  name: "phoenix_org_chart",
  title: "Organogram and headcount",
  description:
    "The organogram as Phoenix draws it from the seat model: every seat with who holds it (or that it is vacant), title, line, region, area and manager, " +
    "with headcount by line and department and the open vacancies. mode = company (default) or line. asOfMonth = a finished YYYY-MM month to see the structure as it stood then.",
  input: {
    mode: z.enum(["company", "line"]).optional(),
    asOfMonth: z.string().optional().describe("A finished month, YYYY-MM."),
  },
  run: async (ctx, input) => {
    // app/(admin)/organogram/page.tsx: organogram:read, then company or line scope.
    if (!(await canAccess(ctx, "organogram", "read"))) throw new ToolRefusal("Your role does not see the organogram.");
    if (input.asOfMonth && !parsePeriod(input.asOfMonth)) throw new ToolRefusal("asOfMonth must be written YYYY-MM.");
    const mode = input.mode ?? (canAccessCompanyOrganogram(ctx) ? "company" : "line");
    const report =
      mode === "company"
        ? await getOrganogramReport(ctx, { mode: "company", asOfMonth: input.asOfMonth ?? null })
        : await getOrganogramReport(ctx, {
            mode: "line",
            lineNames: await resolveOrganogramLinesForEmployee(ctx),
            asOfMonth: input.asOfMonth ?? null,
          });
    if (report.diagnostic) throw new ToolRefusal(report.diagnostic.message);
    const employees = report.organogramRows.filter((row) => row.type === "employee");
    const vacancies = report.organogramRows.filter((row) => row.type === "vacancy");
    const rows = capRows(report.organogramRows, 500);
    const byLine = countBy(employees, (row) => row.lineName);
    return {
      summary:
        `Organogram${input.asOfMonth ? ` as of the end of ${monthLabel(input.asOfMonth)}` : ""} (${mode}): ${employees.length} people in seats, ` +
        `${vacancies.length} vacant seats. By line: ${byLine.slice(0, 6).map((entry) => `${entry.name} ${entry.count}`).join(", ")}.` +
        cappedNote(rows.total, rows.rows.length),
      data: {
        mode,
        asOfMonth: input.asOfMonth ?? null,
        headcount: employees.length,
        vacantSeats: vacancies.length,
        headcountByLine: byLine,
        headcountByDepartment: countBy(employees, (row) => row.departmentName),
        vacancySummary: report.summary,
        seats: rows.rows.map((row) => pickFields(row, ORG_ROW_FIELDS)),
        seatsTotal: rows.total,
        seatsCapped: rows.capped,
      },
    };
  },
});
