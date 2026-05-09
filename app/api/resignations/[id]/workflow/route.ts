import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  getResignationsDashboardData,
  isResignationsSchemaMissing,
  resignationErrorMessage,
  runResignationWorkflow,
} from "@/lib/resignations/service";
import type { ResignationWorkflowAction } from "@/lib/resignations/types";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const action = String(body.action ?? "") as ResignationWorkflowAction;
    const note = body.note ? String(body.note) : undefined;
    const rejectedReason = body.rejectedReason ? String(body.rejectedReason) : undefined;

    const validActions: ResignationWorkflowAction[] = [
      "mark_review",
      "approve",
      "reject",
      "complete",
      "cancel",
      "reopen",
    ];

    if (!validActions.includes(action)) {
      return NextResponse.json({ success: false, error: "Invalid action." }, { status: 400 });
    }

    await assertPermission(
      access,
      "resignations",
      action === "approve" || action === "reject" || action === "complete" ? "approve" : "update",
    );

    const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const updated = await runResignationWorkflow(id, action, actor, note, rejectedReason);
    if (!updated) {
      return NextResponse.json({ success: false, error: "Resignation record not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: updated, dashboard: await getResignationsDashboardData() });
  } catch (error) {
    const message = resignationErrorMessage(error);
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: message }, { status: 403 });
    }
    if (isResignationsSchemaMissing(error)) {
      return NextResponse.json({ success: false, error: "Resignations schema is not ready." }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
