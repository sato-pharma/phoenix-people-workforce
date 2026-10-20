// HR Daily & Weekly Reports — the notices. In-app for her; in-app and Telegram for the HR Manager.
//
// NO AMOUNT IN ANY NOTICE, and no day count either: a notice says a report is waiting and where.
// Recipients are whoever holds each seat today (`resolveHrIdsForRole`), so the notice follows the
// seat when it changes hands. Best effort by design: a report that was built or submitted is never
// lost because a bell could not ring — a failure is logged, never thrown into the request.

import { HR_OPERATIONS_SPECIALIST_SEAT } from "@/lib/auth/hr-functions";
import { canonicalPersonHrId } from "@/lib/auth/identity-aliases";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { resolveHrIdsForRole } from "@/lib/notifications/role-recipients";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";

import { periodTitle } from "./periods";
import type { HrOpsReportRow } from "./types";

/**
 * ONE page serves both ends (app/(admin)/hr-reports): she opens it in the /hr namespace, the HR
 * Manager at its own address on the admin rail, and the page picks the view from the grant.
 */
export const REVIEWER_PAGE_PATH = "/hr/hr-reports";
export const DECIDER_PAGE_PATH = "/hr-reports";

export function reportActionUrl(base: string, reportId: string): string {
  return `${base}?report=${encodeURIComponent(reportId)}`;
}

async function holdersOf(role: PhoenixRole, label: string): Promise<string[]> {
  const { hrIds } = await resolveHrIdsForRole(role, label);
  return [...new Set(hrIds.map((hrId) => canonicalPersonHrId(hrId)).filter((hrId): hrId is string => Boolean(hrId)))];
}

function titleOf(report: Pick<HrOpsReportRow, "kind" | "period_key" | "field_to" | "office_to">): string {
  const anchor = report.period_key.split(":")[1] ?? "";
  return periodTitle({ anchor, fieldTo: report.field_to, kind: report.kind, officeTo: report.office_to });
}

async function send(input: {
  channels: Array<"in_app" | "telegram">;
  eventType: string;
  idempotencyKey: string;
  message: string;
  recipients: string[];
  report: Pick<HrOpsReportRow, "id">;
  title: string;
  url: string;
}): Promise<number> {
  if (input.recipients.length === 0) return 0;
  try {
    await createSystemNotificationForRecipients(
      {
        actionUrl: input.url,
        category: "general",
        channels: input.channels,
        eventType: input.eventType,
        message: input.message,
        metadata: { idempotencyKey: input.idempotencyKey, reportId: input.report.id },
        module: "hr_ops_reports",
        priority: "normal",
        recordId: input.report.id,
        title: input.title,
      },
      input.recipients,
    );
    return input.recipients.length;
  } catch (error) {
    console.warn("[hr-ops-reports] a notice could not be created", error);
    return 0;
  }
}

/** A new report is waiting for her review. Sent once per report. */
export async function notifyReportReady(report: Pick<HrOpsReportRow, "id" | "kind" | "period_key" | "field_to" | "office_to">, flaggedRows: number): Promise<number> {
  const recipients = await holdersOf(HR_OPERATIONS_SPECIALIST_SEAT as PhoenixRole, "HR Daily & Weekly Reports — reviewer");
  const title = titleOf(report);
  return send({
    channels: ["in_app"],
    eventType: "hr_ops_reports.report_ready",
    idempotencyKey: `hr_ops_reports:ready:${report.id}`,
    message: flaggedRows === 0
      ? `${title} is ready. Nothing was flagged.`
      : `${title} is ready for your review: ${flaggedRows} ${flaggedRows === 1 ? "row needs" : "rows need"} your answer.`,
    recipients,
    report,
    title: "A report is ready for your review",
    url: reportActionUrl(REVIEWER_PAGE_PATH, report.id),
  });
}

/** She submitted a report — it now waits on the HR Manager's decision. */
export async function notifyReportSubmitted(report: Pick<HrOpsReportRow, "id" | "kind" | "period_key" | "field_to" | "office_to" | "submitted_at">): Promise<number> {
  const recipients = await holdersOf("Super Admin", "HR Daily & Weekly Reports — decider");
  const title = titleOf(report);
  return send({
    channels: ["in_app", "telegram"],
    eventType: "hr_ops_reports.report_submitted",
    idempotencyKey: `hr_ops_reports:submitted:${report.id}:${report.submitted_at ?? ""}`,
    message: `${title} has been reviewed and is waiting for your decision.`,
    recipients,
    report,
    title: "A report is waiting for your decision",
    url: reportActionUrl(DECIDER_PAGE_PATH, report.id),
  });
}

/** Every row she raised has been decided. */
export async function notifyReportDecided(report: Pick<HrOpsReportRow, "id" | "kind" | "period_key" | "field_to" | "office_to" | "decided_at">): Promise<number> {
  const recipients = await holdersOf(HR_OPERATIONS_SPECIALIST_SEAT as PhoenixRole, "HR Daily & Weekly Reports — reviewer");
  const title = titleOf(report);
  return send({
    channels: ["in_app"],
    eventType: "hr_ops_reports.report_decided",
    idempotencyKey: `hr_ops_reports:decided:${report.id}:${report.decided_at ?? ""}`,
    message: `${title} has been decided.`,
    recipients,
    report,
    title: "A report you reviewed has been decided",
    url: reportActionUrl(REVIEWER_PAGE_PATH, report.id),
  });
}
