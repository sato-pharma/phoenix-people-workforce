import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { ApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  getResignationsDashboardData,
  isResignationsSchemaMissing,
  resignationErrorMessage,
  runResignationWorkflow,
} from "@/lib/resignations/service";
import type { ResignationWorkflowAction } from "@/lib/resignations/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

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

    const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const updated = await runResignationWorkflow(id, action, actor, note, rejectedReason, access);
    if (!updated) {
      return NextResponse.json({ success: false, error: "Resignation record not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: updated, dashboard: await getResignationsDashboardData(access) });
  } catch (error) {
    const message = resignationErrorMessage(error);
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: message }, { status: 403 });
    }
    // A sentence written for HR (Complete stopped at a named step; the resignation is still
    // Approved and Complete is safe to press again) — never a 500.
    if (error instanceof ApiError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    if (isResignationsSchemaMissing(error)) {
      return NextResponse.json({ success: false, error: "Resignations schema is not ready." }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
