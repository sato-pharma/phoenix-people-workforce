// HR Daily & Weekly Reports — HER review and her Submit.
//
// She answers each row (confirm / reject / recommend an edit, with a reason) while the report is
// hers (`in_review`), and submits it when every flagged row has an answer. Submitting hands it to
// the HR Manager and freezes it: the cron no longer rebuilds it, and nothing she does decides a row.
// The route has already asserted `hr_ops_reports:update`; this enforces the report's own state.

import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertNotTestAccount } from "@/lib/auth/test-persona";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { notifyReportSubmitted } from "./notify";
import { decidedElsewhereText, degradedSubmitRefusal, isCarried, needsReview, reportProgress, validateReview, type ReviewInput } from "./rules";
import { getReport, getReportLines, LINES_TABLE, REPORTS_TABLE, storeError, withDecidedElsewhere } from "./store";
import { HrOpsReportsError, type HrOpsReportLineRow, type HrOpsReportRow } from "./types";

/**
 * The spelling an actor column stores. `access.hrId` is the lowercase comparison key, never the
 * stored id, so it goes through `hrIdForStorage` exactly as `decide.ts` does for the decider —
 * one row's reviewer and decider then resolve to a name the same way.
 */
function actorHrId(access: AccessContext): string | null {
  return hrIdForStorage(access.hrId) ?? access.loginId ?? null;
}

async function openReportForReview(reportId: string): Promise<HrOpsReportRow> {
  const report = await getReport(reportId);
  if (!report) throw new HrOpsReportsError("That report does not exist.", 404);
  if (report.status !== "in_review") {
    throw new HrOpsReportsError(
      report.status === "submitted" ? "This report has been submitted and is waiting for the HR Manager's decision." : "This report has been decided.",
      409,
    );
  }
  return report;
}

/** Save her answers to one or more rows. Each is checked before any is written. */
export async function reviewLines(access: AccessContext, reportId: string, body: unknown): Promise<{ saved: number }> {
  assertNotTestAccount(access);
  const raw = (body ?? {}) as { reviews?: unknown };
  const list = Array.isArray(raw.reviews) ? raw.reviews : [body];
  if (list.length === 0) throw new HrOpsReportsError("Nothing to save.");
  if (list.length > 500) throw new HrOpsReportsError("Save at most 500 rows at a time.");
  const reviews: ReviewInput[] = list.map((entry) => validateReview(entry));

  await openReportForReview(reportId);
  const ids = [...new Set(reviews.map((review) => review.lineId))];
  const { data, error } = await getSupabaseAdmin()
    .from(LINES_TABLE)
    .select("id,report_id,section,hr_key,work_date,decision,carried_from_line_id")
    .eq("report_id", reportId)
    .in("id", ids);
  if (error) throw storeError(error, "read the rows");
  // A day decided in another report since this one was built is carried too (store.ts).
  const read = await withDecidedElsewhere((data ?? []) as unknown as HrOpsReportLineRow[]);
  const lines = new Map(read.map((line) => [line.id, line]));
  for (const review of reviews) {
    const line = lines.get(review.lineId);
    if (!line) throw new HrOpsReportsError("A row you answered is not in this report.", 404);
    if (isCarried(line)) {
      const where = !line.carried_from_line_id && line.decided_elsewhere ? decidedElsewhereText(line.decided_elsewhere) : "decided in its daily report";
      throw new HrOpsReportsError(`That day was already ${where} — it is shown here, not reviewed again.`, 409);
    }
  }

  const now = new Date().toISOString();
  const reviewer = actorHrId(access);
  for (const review of reviews) {
    const { error: writeError } = await getSupabaseAdmin()
      .from(LINES_TABLE)
      .update({
        recommended_days: review.recommendedDays,
        review_action: review.action,
        review_comment: review.comment,
        review_reason: review.reason,
        reviewed_at: review.action ? now : null,
        reviewed_by_hr_id: review.action ? reviewer : null,
        updated_at: now,
      })
      .eq("id", review.lineId)
      .eq("report_id", reportId);
    if (writeError) throw storeError(writeError, "save your review");
  }
  return { saved: reviews.length };
}

/**
 * Hand the report to the HR Manager. Every flagged row must have her answer first — and the report
 * must have been built from sources that could all be read, or it is not frozen at all
 * (rules.ts `degradedSubmitRefusal`): a degraded build's rows are missing, not absent on purpose,
 * and submitting auto-decides a report with nothing flagged.
 */
export async function submitReport(access: AccessContext, reportId: string): Promise<{ report: HrOpsReportRow }> {
  assertNotTestAccount(access);
  const open = await openReportForReview(reportId);
  const degraded = degradedSubmitRefusal(open);
  if (degraded) throw new HrOpsReportsError(degraded, 409);
  // With the person-day columns, so a day decided in another report since the build is carried, not
  // a row still waiting for her answer.
  const lines = await getReportLines(reportId, "id,report_id,section,hr_key,work_date,flags,carried_from_line_id,review_action,decision", true);
  const waiting = lines.filter((line) => needsReview(line) && !line.review_action).length;
  if (waiting > 0) {
    throw new HrOpsReportsError(`${waiting} flagged ${waiting === 1 ? "row still needs" : "rows still need"} your answer before you can submit.`, 409);
  }
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(REPORTS_TABLE)
    .update({ status: "submitted", submitted_at: now, submitted_by_hr_id: actorHrId(access), updated_at: now })
    .eq("id", reportId)
    .eq("status", "in_review")
    .select("*")
    .maybeSingle();
  if (error) throw storeError(error, "submit the report");
  if (!data) throw new HrOpsReportsError("This report was submitted a moment ago.", 409);
  const report = data as HrOpsReportRow;

  // A report with nothing to decide is decided the moment it is submitted: there is no row for the
  // HR Manager to act on, and leaving it "waiting" would put an empty item in his queue for ever.
  if (reportProgress(lines).toDecide === 0) {
    const { data: decided } = await getSupabaseAdmin()
      .from(REPORTS_TABLE)
      .update({ decided_at: now, decided_by_hr_id: null, status: "decided", updated_at: now })
      .eq("id", reportId)
      .eq("status", "submitted")
      .select("*")
      .maybeSingle();
    return { report: (decided as HrOpsReportRow | null) ?? report };
  }

  await notifyReportSubmitted(report);
  return { report };
}
