import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  getProbationRows,
  getProbationTrackerRows,
  isProbationSchemaMissing,
  probationErrorMessage,
  runProbationWorkflow,
} from "@/lib/probation/service";
import type { ProbationWorkflowAction } from "@/lib/probation/types";

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
    const action = String(body.action ?? "") as ProbationWorkflowAction;
    const validActions: ProbationWorkflowAction[] = [
      "manager_feedback",
      "pass",
      "terminate",
    ];

    if (!validActions.includes(action)) {
      return NextResponse.json({ success: false, error: "Invalid action." }, { status: 400 });
    }

    await assertPermission(access, "probation", action === "pass" || action === "terminate" ? "approve" : "update");

    const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const data = await runProbationWorkflow(id, action, actor, access, {
      decisionReason: body.decisionReason ? String(body.decisionReason) : undefined,
      evaluationScores: typeof body.evaluationScores === "object" && body.evaluationScores ? body.evaluationScores : undefined,
      expectedUpdatedAt: body.expectedUpdatedAt ? String(body.expectedUpdatedAt) : undefined,
      managerFeedback: body.managerFeedback ? String(body.managerFeedback) : undefined,
      note: body.note ? String(body.note) : undefined,
    });

    if (!data) {
      return NextResponse.json({ success: false, error: "Probation review not found." }, { status: 404 });
    }

    // `rows` is the inside-90-days list the admin tracker shows; `trackerRows` adds the probations
    // that ended with no decision, which the employee portal's tracker lists first.
    const [rows, trackerRows] = await Promise.all([getProbationRows(access), getProbationTrackerRows(access)]);
    return NextResponse.json({ data, rows, success: true, trackerRows });
  } catch (error) {
    const message = probationErrorMessage(error);
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: message }, { status: 403 });
    if (message.toLowerCase().includes("forbidden")) return NextResponse.json({ success: false, error: message }, { status: 403 });
    if (message.toLowerCase().includes("updated by another user")) {
      return NextResponse.json({ success: false, error: message }, { status: 409 });
    }
    if (
      message.toLowerCase().includes("invalid probation transition") ||
      message.toLowerCase().includes("required") ||
      message.toLowerCase().includes("must be later")
    ) {
      return NextResponse.json({ success: false, error: message }, { status: 400 });
    }
    if (isProbationSchemaMissing(error)) {
      return NextResponse.json({ success: false, error: "Probation review schema is not ready." }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
