// HR Daily & Weekly Reports — every read and write of the two tables, in one place.
//
// Service role only (the migration revokes both tables from anon and authenticated): every caller
// is a server route or the cron, and each has already checked the seat before it gets here.

import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { markDecidedElsewhere } from "./rules";
import {
  HR_OPS_LINE_COLUMNS,
  HR_OPS_REPORT_COLUMNS,
  HrOpsReportsError,
  type HrOpsReportLineRow,
  type HrOpsReportRow,
} from "./types";

export const REPORTS_TABLE = "hr_ops_reports";
export const LINES_TABLE = "hr_ops_report_lines";

type DbError = { code?: string | null; message?: string | null } | null | undefined;

/** A deploy can reach production before its migration; that is said plainly, never as an empty list. */
export function isMissingTable(error: DbError): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "PGRST205" || code === "42P01") return true;
  const message = String(error.message ?? "");
  return /hr_ops_report/i.test(message) && /does not exist|schema cache/i.test(message);
}

export function storeError(error: DbError, doing: string): Error {
  if (isMissingTable(error)) {
    return new HrOpsReportsError("The Daily & Weekly Reports are not set up in this database yet.", 503);
  }
  return new Error(`Could not ${doing}: ${error?.message ?? "unknown error"}`);
}

export async function listReports(input: { limit?: number; statuses?: readonly string[] } = {}): Promise<HrOpsReportRow[]> {
  let query = getSupabaseAdmin().from(REPORTS_TABLE).select(HR_OPS_REPORT_COLUMNS);
  if (input.statuses?.length) query = query.in("status", [...input.statuses]);
  const { data, error } = await query.order("built_at", { ascending: false }).limit(Math.min(Math.max(input.limit ?? 60, 1), 200));
  if (error) throw storeError(error, "read the reports");
  return (data ?? []) as unknown as HrOpsReportRow[];
}

export async function getReport(id: string): Promise<HrOpsReportRow | null> {
  const { data, error } = await getSupabaseAdmin().from(REPORTS_TABLE).select(HR_OPS_REPORT_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw storeError(error, "read the report");
  return (data ?? null) as unknown as HrOpsReportRow | null;
}

export async function findReportByPeriod(periodKey: string): Promise<HrOpsReportRow | null> {
  const { data, error } = await getSupabaseAdmin().from(REPORTS_TABLE).select(HR_OPS_REPORT_COLUMNS).eq("period_key", periodKey).maybeSingle();
  if (error) throw storeError(error, "read the report");
  return (data ?? null) as unknown as HrOpsReportRow | null;
}

/**
 * Every line of a report — a weekly report runs past PostgREST's 1,000-row page, so it is paged.
 *
 * READ AS THE SCREENS SEE IT: with `decidedElsewhere` (on by default for the full row) every row whose
 * person-day was decided in another report is marked (`withDecidedElsewhere`), so progress, the queue
 * and the decision all count it as carried. A narrow read that feeds a count passes `true` and selects
 * `report_id,section,hr_key,work_date,decision,carried_from_line_id` with it.
 */
export async function getReportLines(
  reportId: string,
  columns = HR_OPS_LINE_COLUMNS,
  decidedElsewhere = columns === HR_OPS_LINE_COLUMNS,
): Promise<HrOpsReportLineRow[]> {
  let lines: HrOpsReportLineRow[];
  try {
    lines = await fetchAllRowsKeyset<HrOpsReportLineRow>(
      () => getSupabaseAdmin().from(LINES_TABLE).select(columns).eq("report_id", reportId),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    );
  } catch (error) {
    throw storeError(error as DbError, "read the report's rows");
  }
  return decidedElsewhere ? withDecidedElsewhere(lines) : lines;
}

/** The lines of several reports at once, for the counts the queue and the overview show. */
export async function getLinesForReports(reportIds: readonly string[], columns: string, decidedElsewhere = false): Promise<HrOpsReportLineRow[]> {
  if (reportIds.length === 0) return [];
  let lines: HrOpsReportLineRow[];
  try {
    lines = await fetchAllRowsKeyset<HrOpsReportLineRow>(
      () => getSupabaseAdmin().from(LINES_TABLE).select(columns).in("report_id", [...reportIds]),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    );
  } catch (error) {
    throw storeError(error as DbError, "read the reports' rows");
  }
  return decidedElsewhere ? withDecidedElsewhere(lines) : lines;
}

/** The named reports, by id. */
export async function getReportsByIds(ids: readonly string[]): Promise<HrOpsReportRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await getSupabaseAdmin().from(REPORTS_TABLE).select(HR_OPS_REPORT_COLUMNS).in("id", [...ids]);
  if (error) throw storeError(error, "read the reports");
  return (data ?? []) as unknown as HrOpsReportRow[];
}

/**
 * Mark each undecided, uncarried row whose person-day was decided in ANOTHER report (rules.ts
 * `markDecidedElsewhere`). Reads the decided rows of the rows' own date window and names their
 * reports. A read that fails throws: a report drawn with a day "to decide" that is in fact decided
 * elsewhere is the defect this closes, so it is never drawn that way on a failed read.
 */
export async function withDecidedElsewhere(lines: HrOpsReportLineRow[]): Promise<HrOpsReportLineRow[]> {
  const open = lines.filter((line) => !line.decision && !line.carried_from_line_id && line.work_date && line.hr_key && line.report_id);
  if (open.length === 0) return lines.map((line) => ({ ...line, decided_elsewhere: null }));
  const dates = open.map((line) => line.work_date).sort();
  const wanted = new Set(open.map((line) => `${line.section}|${line.hr_key}|${line.work_date}`));
  const decided = (await getDecidedLinesInWindow({ excludeReportId: null, from: dates[0]!, to: dates[dates.length - 1]! })).filter((row) =>
    wanted.has(`${row.section}|${row.hr_key}|${row.work_date}`),
  );
  if (decided.length === 0) return lines.map((line) => ({ ...line, decided_elsewhere: null }));
  const reports = await getReportsByIds([...new Set(decided.map((row) => row.report_id))]);
  return markDecidedElsewhere(lines, decided, new Map(reports.map((report) => [report.id, report])));
}

/** Lines of OTHER reports on the given days — what a weekly report carries from its daily ones. */
export async function getDecidedLinesInWindow(input: {
  excludeReportId: string | null;
  from: string;
  to: string;
}): Promise<Array<Pick<HrOpsReportLineRow, "id" | "report_id" | "section" | "hr_key" | "work_date" | "decision">>> {
  try {
    const rows = await fetchAllRowsKeyset<Pick<HrOpsReportLineRow, "id" | "report_id" | "section" | "hr_key" | "work_date" | "decision">>(
      () =>
        getSupabaseAdmin()
          .from(LINES_TABLE)
          .select("id,report_id,section,hr_key,work_date,decision")
          .gte("work_date", input.from)
          .lte("work_date", input.to)
          .not("decision", "is", null),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    );
    return input.excludeReportId ? rows.filter((row) => row.report_id !== input.excludeReportId) : rows;
  } catch (error) {
    throw storeError(error as DbError, "read the days already decided");
  }
}
