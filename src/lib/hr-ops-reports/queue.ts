// HR Daily & Weekly Reports — the queue, as the HR Overview and the today panel read it.
//
// COUNTS AND TITLES ONLY. No row of a report crosses into the Overview: a tile says how many rows
// wait for her answer, a task names the REPORT that holds them, and the report itself is opened on
// its own page. Days are not summed here either — a landing page shows work waiting, not a total of
// deduction days.
//
// Read from the same rules the report page uses (`reportProgress`), so "12 rows to answer" on the
// Overview and on the report cannot disagree.

import { parsePeriodKey, periodEnd, periodTitle } from "./periods";
import { reportProgress, type ReportProgress } from "./rules";
import { getLinesForReports, listReports } from "./store";
import { HR_OPS_STATUS_LABELS, type HrOpsReportKind, type HrOpsReportRow, type HrOpsReportStatus } from "./types";

/** How many of the newest reports the Overview's chart plots. */
export const QUEUE_CHART_REPORTS = 10;

export type HrOpsQueueReport = {
  id: string;
  kind: HrOpsReportKind;
  title: string;
  /** "10 Oct" style label for a chart axis. */
  shortLabel: string;
  status: HrOpsReportStatus;
  statusLabel: string;
  periodEnd: string;
  builtAt: string;
  submittedAt: string | null;
  progress: ReportProgress;
};

export type HrOpsReportsQueue = {
  /** Newest first: every report still open, then the most recent decided ones up to the chart's reach. */
  reports: HrOpsQueueReport[];
  summary: {
    /** Reports still with her. */
    inReview: number;
    /** Flagged rows in those reports with no answer from her yet. */
    rowsToAnswer: number;
    /** Reports she has submitted that wait on the HR Manager. */
    submitted: number;
    /** Rows in those reports he has not decided yet. */
    rowsToDecide: number;
  };
};

const LINE_FACTS = "id,report_id,flags,carried_from_line_id,review_action,decision";

const SHORT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function shortLabel(report: Pick<HrOpsReportRow, "kind" | "period_key">): string {
  const anchor = parsePeriodKey(report.period_key)?.anchor;
  if (!anchor) return report.period_key;
  const day = SHORT.format(new Date(`${anchor}T00:00:00Z`));
  return report.kind === "weekly" ? `Week of ${day}` : day;
}

/** Pure: shape the reports and their line facts into the queue. Exported for the tests. */
export function buildQueue(
  reports: readonly HrOpsReportRow[],
  lines: ReadonlyArray<{ report_id: string } & Parameters<typeof reportProgress>[0][number]>,
): HrOpsReportsQueue {
  const byReport = new Map<string, Array<Parameters<typeof reportProgress>[0][number]>>();
  for (const line of lines) {
    const list = byReport.get(line.report_id) ?? [];
    list.push(line);
    byReport.set(line.report_id, list);
  }
  const shaped: HrOpsQueueReport[] = reports.map((report) => {
    const anchor = parsePeriodKey(report.period_key)?.anchor ?? report.field_from ?? report.office_from ?? "";
    return {
      builtAt: report.built_at,
      id: report.id,
      kind: report.kind,
      periodEnd: periodEnd({ anchor, fieldTo: report.field_to, officeTo: report.office_to }),
      progress: reportProgress(byReport.get(report.id) ?? []),
      shortLabel: shortLabel(report),
      status: report.status,
      statusLabel: HR_OPS_STATUS_LABELS[report.status] ?? report.status,
      submittedAt: report.submitted_at,
      title: anchor ? periodTitle({ anchor, fieldTo: report.field_to, kind: report.kind, officeTo: report.office_to }) : report.period_key,
    };
  });
  const summary = { inReview: 0, rowsToAnswer: 0, rowsToDecide: 0, submitted: 0 };
  for (const report of shaped) {
    if (report.status === "in_review") {
      summary.inReview += 1;
      summary.rowsToAnswer += report.progress.toReview;
    } else if (report.status === "submitted") {
      summary.submitted += 1;
      summary.rowsToDecide += report.progress.toDecide;
    }
  }
  return { reports: shaped, summary };
}

/**
 * The report list both pages open on: the newest reports, with progress counted for every report
 * still open (a decided report shows its row count, which is all its card needs).
 */
export async function loadReportList(input: { limit?: number } = {}): Promise<HrOpsQueueReport[]> {
  const reports = await listReports({ limit: input.limit ?? 60 });
  const open = reports.filter((report) => report.status !== "decided");
  const lines = await getLinesForReports(open.map((report) => report.id), LINE_FACTS);
  return buildQueue(reports, lines as unknown as Parameters<typeof buildQueue>[1]).reports;
}

/**
 * The live queue. Throws when the tables cannot be read (a 503 HrOpsReportsError when they do not
 * exist yet) — the Overview's `safe()` turns that into "Daily & Weekly Reports could not be read",
 * never into a zero.
 */
export async function loadHrOpsReportsQueue(): Promise<HrOpsReportsQueue> {
  const recent = await listReports({ limit: 40 });
  const open = recent.filter((report) => report.status !== "decided");
  const decided = recent.filter((report) => report.status === "decided").slice(0, Math.max(0, QUEUE_CHART_REPORTS - open.length));
  const chosen = [...open, ...decided].sort((left, right) => right.period_key.localeCompare(left.period_key) || right.built_at.localeCompare(left.built_at));
  const lines = await getLinesForReports(chosen.map((report) => report.id), LINE_FACTS);
  return buildQueue(chosen, lines as unknown as Parameters<typeof buildQueue>[1]);
}
