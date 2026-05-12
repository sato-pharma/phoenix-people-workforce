import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { safeSendNotificationEmail } from "@/lib/notifications/email";
import { isPayrollConflictError } from "@/lib/payroll/errors";
import { runPayrollWorkflow } from "@/lib/payroll/service";
import type { PayrollWorkflowAction } from "@/lib/payroll/types";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const action = String(body.action ?? "") as PayrollWorkflowAction;
    const rejectedReason = body.rejectedReason ? String(body.rejectedReason) : undefined;

    const validActions: PayrollWorkflowAction[] = ["mark_review", "approve", "lock", "reject", "reopen"];
    if (!validActions.includes(action)) {
      return NextResponse.json({ success: false, error: "Invalid action." }, { status: 400 });
    }

    await assertPermission(access, "payroll", action === "approve" ? "approve" : "update");
    const actorIdentity = resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const updated = await runPayrollWorkflow(id, action, actorIdentity, rejectedReason);
    if (!updated) {
      return NextResponse.json({ success: false, error: "Batch not found." }, { status: 404 });
    }

    await safeSendNotificationEmail({
      ctaHref: `/payroll?batchId=${updated.id}`,
      ctaLabel: "Open payroll dashboard",
      metrics: [
        { label: "Action", value: action },
        { label: "New status", value: updated.status },
        { label: "Payroll period", value: `${updated.month}/${updated.year}` },
        { label: "Source file", value: updated.fileName },
      ],
      subject: `Phoenix Payroll ${updated.status} - ${updated.month}/${updated.year}`,
      summary:
        action === "reject"
          ? `Payroll workflow was rejected. Reason: ${rejectedReason ?? "No reason provided."}`
          : `Payroll workflow action "${action}" was completed by ${actorIdentity}.`,
      title: "Payroll Workflow Updated",
      tone: action === "approve" || action === "lock" ? "success" : action === "reject" ? "danger" : "warning",
    });

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
