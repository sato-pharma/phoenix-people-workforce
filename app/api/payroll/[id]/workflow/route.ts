import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { createSystemNotification } from "@/lib/notifications/system";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { isPayrollConflictError } from "@/lib/payroll/errors";
import { payrollBatchHref, payrollBatchNotificationMetadata } from "@/lib/payroll/links";
import { runPayrollWorkflow } from "@/lib/payroll/service";
import type { PayrollWorkflowAction } from "@/lib/payroll/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { notifyPayslipAvailable } from "@/lib/payroll/notify-payslip-available";
import { logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const action = String(body.action ?? "") as PayrollWorkflowAction;
    const rejectedReason = body.rejectedReason ? String(body.rejectedReason) : undefined;

    const validActions: PayrollWorkflowAction[] = [
      "mark_part1_ready",
      "mark_part1_paid",
      "open_adjustments",
      "mark_part2_ready",
      "mark_review",
      "approve",
      "lock",
      "reject",
      "reopen",
    ];
    if (!validActions.includes(action)) {
      return NextResponse.json({ success: false, error: "Invalid action." }, { status: 400 });
    }

    await assertPermission(access, "payroll", action === "approve" ? "approve" : "update");
    const actorIdentity = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const updated = await runPayrollWorkflow(id, action, access, actorIdentity, rejectedReason);
    if (!updated) {
      return NextResponse.json({ success: false, error: "Batch not found." }, { status: 404 });
    }

    const batchHref = payrollBatchHref(updated.id);
    // "workflow_updated" is an ops event about a BATCH, not a specific employee — there is no
    // subject to resolve permission_based against (permissionBasedRecipients bails on
    // `if (!subject) continue` before it reaches the company/system-scope bypass), so this
    // reached nobody in production (8 events, all NULL employee_hr_id, last 2026-07-13). Name
    // the audience explicitly via the admin-editable payroll_workflow_alert role policy —
    // owner decision 2026-08-09: Super Admin, CEO, Finance Manager. Each still has to pass
    // canAccess(context, "payroll", "read") individually.
    const { recipients: alertRecipients, warnings: alertWarnings } =
      await resolveNotificationPersonRecipients("payroll_workflow_alert", "Payroll workflow alert recipients");
    if (alertWarnings.length > 0) {
      logError("Payroll workflow alert recipient resolution warned", {
        labels: { event: "payroll_workflow_alert_recipients_warning", batch_id: String(updated.id) },
        error: new Error(alertWarnings.join("; ")),
      });
    }
    const moduleOwnerHrIds = alertRecipients.map((recipient) => recipient.hrId).filter(Boolean);
    await createSystemNotification({
      actionUrl: batchHref,
      actorId: actorIdentity,
      email: {
        ctaHref: batchHref,
        ctaLabel: "Open payroll dashboard",
        metrics: [
          { label: "Action", value: action },
          { label: "New status", value: updated.status },
          { label: "Payroll period", value: `${updated.month}/${updated.year}` },
          { label: "Source file", value: updated.fileName },
        ],
        notificationType: "general",
        subject: `Phoenix Payroll ${updated.status} - ${updated.month}/${updated.year}`,
        summary:
          action === "reject"
            ? `Payroll workflow was rejected. Reason: ${rejectedReason ?? "No reason provided."}`
            : `Payroll workflow action "${action}" was completed by ${actorIdentity}.`,
        // Explicit context so {{status}} in the payroll_update template renders the clean new
        // status instead of the generic "Label: value | Label: value | ..." dump of every
        // metric above (notificationMetricStatus in src/lib/notifications/email.ts).
        templateContext: {
          status: action === "reject"
            ? `Rejected — ${rejectedReason ?? "no reason provided"}`
            : `${updated.status.replace(/_/g, " ")} (${updated.month}/${updated.year})`,
        },
        title: "Payroll Workflow Updated",
        tone: action === "approve" || action === "lock" || action === "mark_part1_paid" ? "success" : action === "reject" ? "danger" : "warning",
      },
      eventType: "workflow_updated",
      message:
        action === "reject"
          ? "Payroll workflow was rejected."
          : `Payroll workflow action "${action}" was completed.`,
      metadata: {
        action,
        ...payrollBatchNotificationMetadata(updated.id),
        idempotencyKey: `payroll-workflow:${updated.id}:${updated.status}:${action}`,
        moduleOwnerHrIds,
        sensitivity: "payroll",
        status: updated.status,
      },
      module: "payroll",
      priority: action === "approve" || action === "lock" ? "critical" : "high",
      recordId: String(updated.id),
      title: "Payroll Workflow Updated",
    });

    // Payslips first become visible to employees the moment a batch is approved (see the
    // publishedPayslipStatuses gate in payslip-center.ts / app/api/payroll/[id]/payslips/route.ts).
    // The sender itself lives in `@/lib/payroll/notify-payslip-available` rather than here, because
    // Automated Payroll needs the same call and a helper private to this route file was the reason
    // it silently did without one for 205 people.
    if (action === "approve") {
      await notifyPayslipAvailable({ batchId: updated.id });
    }

    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Workflow action failed.");
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: message }, { status: 403 });
    }
    if (isPayrollConflictError(error)) {
      return NextResponse.json({ success: false, error: message }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
