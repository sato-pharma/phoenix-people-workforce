import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { createSystemNotification } from "@/lib/notifications/system";
import { isPayrollConflictError } from "@/lib/payroll/errors";
import { payrollBatchHref, payrollBatchNotificationMetadata } from "@/lib/payroll/links";
import { runPayrollWorkflow } from "@/lib/payroll/service";
import type { PayrollWorkflowAction } from "@/lib/payroll/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Payslips first become visible the moment a batch is approved (publishedPayslipStatuses in
// payslip-center.ts / app/api/payroll/[id]/payslips/route.ts includes "approved" and "locked",
// and "approve" is the transition that first enters that set). The "payroll.payslip_available"
// notification type (src/lib/notifications/policy.ts) was defined but never fired anywhere —
// employees had no signal their payslip was ready. Best-effort: a failure here must never block
// the payroll workflow response, matching createSystemNotification's own non-throwing contract.
async function notifyEmployeesPayslipAvailable(batchId: string) {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("salary_records")
      .select("hr_id")
      .eq("batch_id", batchId);
    if (error) throw error;

    const hrIds = Array.from(
      new Set((data ?? []).map((row) => String((row as { hr_id: string | null }).hr_id ?? "").trim()).filter(Boolean)),
    );

    await Promise.all(hrIds.map((hrId) => createSystemNotification({
      actionUrl: "/payslips",
      email: {
        ctaHref: "/payslips",
        ctaLabel: "View your payslip",
        notificationType: "general",
        subject: "Your payslip is ready",
        summary: "Your payslip for this payroll period is now available to view.",
        title: "Payslip Available",
        tone: "success",
      },
      eventType: "payslip_available",
      message: "Your payslip is now available to view.",
      metadata: {
        batchId,
        idempotencyKey: `payroll-payslip-available:${batchId}:${hrId}`,
        sensitivity: "payroll",
      },
      module: "payroll",
      priority: "high",
      recipientHrId: hrId,
      recordId: batchId,
      subjectHrId: hrId,
      title: "Payslip Available",
    })));
  } catch (error) {
    console.error("[payroll-workflow] failed to send payslip-available notifications", error);
  }
}

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
    const actorIdentity = resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const updated = await runPayrollWorkflow(id, action, access, actorIdentity, rejectedReason);
    if (!updated) {
      return NextResponse.json({ success: false, error: "Batch not found." }, { status: 404 });
    }

    const batchHref = payrollBatchHref(updated.id);
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
    // Notify each employee in the batch individually — this was previously a defined-but-never-fired
    // notification type (payroll.payslip_available), so employees had no signal their payslip was ready.
    if (action === "approve") {
      await notifyEmployeesPayslipAvailable(updated.id);
    }

    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflow action failed.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: message }, { status: 403 });
    }
    if (isPayrollConflictError(error)) {
      return NextResponse.json({ success: false, error: message }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
