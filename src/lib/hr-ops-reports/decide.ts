// HR Daily & Weekly Reports — HIS decision.
//
// The HR Manager approves a row with the days that stand, or rejects it. Only the Super Admin holds
// `hr_ops_reports:approve` (src/lib/auth/permissions.ts), and the route asserts it before this runs,
// so a reviewer can never decide her own recommendation. An approved row with days is handed to the
// weekly attendance review by bridge.ts; it waits there until its week is open, and the cron retries.
// An approved OFFICE row the weekly review can never hold (no fingerprint row, or a day the policy
// charges nothing — rules.ts `reachesWeeklyReview`) is saved for the record and is final at once:
// "Not carried to payroll", never `waiting` for a day that will not come (owner decision, 2026-10-20).
//
// ONE APPROVED DEDUCTION PER PERSON, DAY AND SECTION, across every report — the database's unique
// partial index (hr_ops_report_lines_one_approved_day) refuses the second even if two clicks race,
// and this answers it in words.

import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertTestAccountWriteIsDryRun } from "@/lib/auth/test-dry-run";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { bridgeDecidedLines } from "./bridge";
import { notifyReportDecided } from "./notify";
import { formatDayLong } from "./periods";
import {
  bridgeStartForDecision,
  decidedElsewhereText,
  decisionIsOpen,
  isDecidable,
  reportProgress,
  validateDecision,
  type DecisionInput,
} from "./rules";
import { getReport, getReportLines, getReportsByIds, LINES_TABLE, REPORTS_TABLE, storeError } from "./store";
import { HrOpsReportsError, type HrOpsReportLineRow, type HrOpsReportRow } from "./types";

export type DecideResult = {
  decided: number;
  report: HrOpsReportRow;
  bridge: Awaited<ReturnType<typeof bridgeDecidedLines>> | null;
  bridgeError: string | null;
};

const UNIQUE_VIOLATION = "23505";

export async function decideLines(access: AccessContext, reportId: string, body: unknown): Promise<DecideResult> {
  await assertTestAccountWriteIsDryRun(access);
  const raw = (body ?? {}) as { decisions?: unknown };
  const list = Array.isArray(raw.decisions) ? raw.decisions : [body];
  if (list.length === 0) throw new HrOpsReportsError("Nothing to decide.");
  if (list.length > 500) throw new HrOpsReportsError("Decide at most 500 rows at a time.");
  const decisions: DecisionInput[] = list.map((entry) => validateDecision(entry));

  const report = await getReport(reportId);
  if (!report) throw new HrOpsReportsError("That report does not exist.", 404);
  if (report.status === "in_review") {
    throw new HrOpsReportsError("This report is still being reviewed — it can be decided once it has been submitted.", 409);
  }

  const lines = await getReportLines(reportId);
  const byId = new Map(lines.map((line) => [line.id, line]));
  for (const decision of decisions) {
    const line = byId.get(decision.lineId);
    if (!line) throw new HrOpsReportsError("A row you decided is not in this report.", 404);
    if (!isDecidable(line)) {
      throw new HrOpsReportsError(
        line.carried_from_line_id
          ? `${line.employee_name}'s day was already decided in its daily report.`
          : line.decided_elsewhere && !line.decision
            ? `${line.employee_name}'s ${formatDayLong(line.work_date)} was already ${decidedElsewhereText(line.decided_elsewhere)} — a day is decided once.`
            : `${line.employee_name}'s row has nothing to decide.`,
        409,
      );
    }
    if (!decisionIsOpen(line)) {
      throw new HrOpsReportsError(
        `${line.employee_name}'s ${formatDayLong(line.work_date)} is already in the weekly attendance review and cannot be changed here — change it there.`,
        409,
      );
    }
  }
  await refuseDaysDecidedElsewhere(reportId, decisions.map((decision) => byId.get(decision.lineId)!));

  const now = new Date().toISOString();
  const decider = hrIdForStorage(access.hrId) ?? access.loginId ?? null;
  for (const decision of decisions) {
    const line = byId.get(decision.lineId)!;
    // An approval on an office row the weekly review can never hold is final at once: "Not carried".
    const start = bridgeStartForDecision(line, decision.decision, decision.days);
    const { data: written, error } = await getSupabaseAdmin()
      .from(LINES_TABLE)
      .update({
        bridge_message: start.message,
        bridge_status: start.status,
        decided_at: now,
        decided_by_hr_id: decider,
        decided_days: decision.decision === "approved" ? decision.days : null,
        decision: decision.decision,
        updated_at: now,
      })
      .eq("id", decision.lineId)
      .eq("report_id", reportId)
      // decisionIsOpen, again at the write: a carry that ran between the read above and this
      // update has put the day in the weekly review, and the decision then stays as it was.
      .is("bridge_ref", null)
      .not("bridge_status", "in", "(bridged,week_released)")
      .select("id");
    if (error) {
      if (String(error.code ?? "") === UNIQUE_VIOLATION) {
        throw new HrOpsReportsError(`${line.employee_name}'s ${formatDayLong(line.work_date)} is already approved in another report — a day is deducted once.`, 409);
      }
      throw storeError(error, "save the decision");
    }
    if (!written || written.length === 0) {
      throw new HrOpsReportsError(
        `${line.employee_name}'s ${formatDayLong(line.work_date)} reached the weekly attendance review a moment ago — change it there.`,
        409,
      );
    }
  }

  // Hand the approved days to the weekly attendance review. A failure here leaves them waiting —
  // the decision is saved, and the cron retries every run.
  let bridge: DecideResult["bridge"] = null;
  let bridgeError: string | null = null;
  try {
    bridge = await bridgeDecidedLines({ reportId });
  } catch (error) {
    bridgeError = error instanceof Error ? error.message : "The weekly attendance review could not be reached.";
  }

  const current = (await settleIfNothingLeft(report, decider, now)) ?? report;

  // The same person-days may sit undecided in another SUBMITTED report (a daily one under this weekly,
  // or the reverse). They are carried there now, so that report may have nothing left to decide —
  // it is settled here rather than left "Submitted" for ever. The decisions above are saved whatever
  // happens below; a failure is logged, never thrown.
  try {
    await settleOtherReports(reportId, decisions.map((decision) => byId.get(decision.lineId)!), decider, now);
  } catch (error) {
    logError("HR Daily & Weekly Reports: another report holding the decided days could not be settled", {
      error,
      labels: { event: "hr_ops_reports_settle_failed", reportId },
    });
  }

  return { bridge, bridgeError, decided: decisions.length, report: current };
}

/** Counted the way the report page counts: a day decided in another report is carried. */
const PROGRESS_COLUMNS = "id,report_id,section,hr_key,work_date,flags,carried_from_line_id,review_action,decision";

/** A submitted report with nothing left to decide becomes Decided, and he is told. Null when it stays. */
async function settleIfNothingLeft(report: HrOpsReportRow, decider: string | null, now: string): Promise<HrOpsReportRow | null> {
  if (report.status !== "submitted") return null;
  const lines = await getReportLines(report.id, PROGRESS_COLUMNS, true);
  if (reportProgress(lines).toDecide !== 0) return null;
  const { data } = await getSupabaseAdmin()
    .from(REPORTS_TABLE)
    .update({ decided_at: now, decided_by_hr_id: decider, status: "decided", updated_at: now })
    .eq("id", report.id)
    .eq("status", "submitted")
    .select("*")
    .maybeSingle();
  if (!data) return null;
  const decided = data as HrOpsReportRow;
  await notifyReportDecided(decided);
  return decided;
}

/** Settle every OTHER submitted report that holds one of these person-days undecided. */
async function settleOtherReports(reportId: string, lines: HrOpsReportLineRow[], decider: string | null, now: string): Promise<void> {
  const keys = [...new Set(lines.map((line) => line.hr_key))];
  const dates = [...new Set(lines.map((line) => line.work_date))].sort();
  if (keys.length === 0 || dates.length === 0) return;
  const days = new Set(lines.map((line) => `${line.section}|${line.hr_key}|${line.work_date}`));
  const { data, error } = await getSupabaseAdmin()
    .from(LINES_TABLE)
    .select("report_id,section,hr_key,work_date")
    .in("hr_key", keys)
    .gte("work_date", dates[0])
    .lte("work_date", dates[dates.length - 1])
    .neq("report_id", reportId)
    .is("decision", null);
  if (error) throw storeError(error, "find the other reports holding these days");
  const reportIds = [
    ...new Set(
      ((data ?? []) as Array<Pick<HrOpsReportLineRow, "report_id" | "section" | "hr_key" | "work_date">>)
        .filter((row) => days.has(`${row.section}|${row.hr_key}|${row.work_date}`))
        .map((row) => row.report_id),
    ),
  ];
  for (const report of await getReportsByIds(reportIds)) {
    await settleIfNothingLeft(report, decider, now);
  }
}

/** A day decided in ANOTHER report (the daily one under a weekly, or the reverse) is not decided twice. */
async function refuseDaysDecidedElsewhere(reportId: string, lines: HrOpsReportLineRow[]): Promise<void> {
  const keys = [...new Set(lines.map((line) => line.hr_key))];
  const dates = [...new Set(lines.map((line) => line.work_date))].sort();
  if (keys.length === 0 || dates.length === 0) return;
  const { data, error } = await getSupabaseAdmin()
    .from(LINES_TABLE)
    .select("id,report_id,section,hr_key,work_date,employee_name")
    .in("hr_key", keys)
    .gte("work_date", dates[0])
    .lte("work_date", dates[dates.length - 1])
    .neq("report_id", reportId)
    .not("decision", "is", null);
  if (error) throw storeError(error, "check the days already decided");
  const elsewhere = new Set(((data ?? []) as HrOpsReportLineRow[]).map((row) => `${row.section}|${row.hr_key}|${row.work_date}`));
  for (const line of lines) {
    if (elsewhere.has(`${line.section}|${line.hr_key}|${line.work_date}`)) {
      throw new HrOpsReportsError(`${line.employee_name}'s ${formatDayLong(line.work_date)} was already decided in another report — a day is decided once.`, 409);
    }
  }
}
