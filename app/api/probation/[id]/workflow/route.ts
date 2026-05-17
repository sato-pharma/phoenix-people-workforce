import { NextResponse } from "next/server";

import { resolveEmployeeIdentityId } from "@/lib/auth/permissions";
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
      "pass",
      "extend",
      "terminate",
      "upload_letter",
    ];

    if (!validActions.includes(action)) {
      return NextResponse.json({ success: false, error: "Invalid action." }, { status: 400 });
    }

    const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const data = await runProbationWorkflow(id, action, actor, access, {
      decisionReason: body.decisionReason ? String(body.decisionReason) : undefined,
      evaluationScores: typeof body.evaluationScores === "object" && body.evaluationScores ? body.evaluationScores : undefined,
      expectedUpdatedAt: body.expectedUpdatedAt ? String(body.expectedUpdatedAt) : undefined,
      extensionEndDate: body.extensionEndDate ? String(body.extensionEndDate) : undefined,
      managerFeedback: body.managerFeedback ? String(body.managerFeedback) : undefined,
      note: body.note ? String(body.note) : undefined,
      probationLetterName: body.probationLetterName ? String(body.probationLetterName) : undefined,
      probationLetterUrl: body.probationLetterUrl ? String(body.probationLetterUrl) : undefined,
    });

    if (!data) {
      return NextResponse.json({ success: false, error: "Probation review not found." }, { status: 404 });
    }

    return NextResponse.json({ data, rows: await getProbationRows(access), success: true });
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
