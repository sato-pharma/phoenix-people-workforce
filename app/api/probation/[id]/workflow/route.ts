import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  getProbationRows,
  isProbationSchemaMissing,
  probationErrorMessage,
  runProbationWorkflow,
} from "@/lib/probation/service";
import type { ProbationWorkflowAction } from "@/lib/probation/types";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const action = String(body.action ?? "") as ProbationWorkflowAction;
    const validActions: ProbationWorkflowAction[] = [
      "manager_feedback",
      "hr_recommendation",
      "approve_pass",
      "approve_extend",
      "approve_terminate",
      "upload_letter",
      "complete",
      "cancel",
      "reopen",
    ];

    if (!validActions.includes(action)) {
      return NextResponse.json({ success: false, error: "Invalid action." }, { status: 400 });
    }

    await assertPermission(access, "probation", action.startsWith("approve") ? "approve" : "update");
    const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const data = await runProbationWorkflow(id, action, actor, {
      decisionReason: body.decisionReason ? String(body.decisionReason) : undefined,
      evaluationScores: typeof body.evaluationScores === "object" && body.evaluationScores ? body.evaluationScores : undefined,
      extensionEndDate: body.extensionEndDate ? String(body.extensionEndDate) : undefined,
      hrRecommendation: body.hrRecommendation ? String(body.hrRecommendation) : undefined,
      managerFeedback: body.managerFeedback ? String(body.managerFeedback) : undefined,
      note: body.note ? String(body.note) : undefined,
      probationLetterName: body.probationLetterName ? String(body.probationLetterName) : undefined,
      probationLetterUrl: body.probationLetterUrl ? String(body.probationLetterUrl) : undefined,
    });

    if (!data) {
      return NextResponse.json({ success: false, error: "Probation workflow not found." }, { status: 404 });
    }

    return NextResponse.json({ data, rows: await getProbationRows(), success: true });
  } catch (error) {
    const message = probationErrorMessage(error);
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: message }, { status: 403 });
    if (isProbationSchemaMissing(error)) {
      return NextResponse.json({ success: false, error: "Probation workflow schema is not ready." }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
