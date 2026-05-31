import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  createProbationEvaluation,
  getProbationRows,
  isProbationSchemaMissing,
  probationErrorMessage,
} from "@/lib/probation/service";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "update");
    const body = await request.json();
    const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const data = await createProbationEvaluation(
      {
        employeeHrId: String(body.employeeHrId ?? ""),
        evaluationScores: typeof body.evaluationScores === "object" && body.evaluationScores ? body.evaluationScores : undefined,
        managerFeedback: body.managerFeedback ? String(body.managerFeedback) : undefined,
        workflowNotes: body.workflowNotes ? String(body.workflowNotes) : undefined,
      },
      actor,
      access,
    );

    return NextResponse.json({ data, rows: await getProbationRows(access), success: true });
  } catch (error) {
    const message = probationErrorMessage(error);
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: message }, { status: 403 });
    if (message.toLowerCase().includes("forbidden")) return NextResponse.json({ success: false, error: message }, { status: 403 });
    if (message.toLowerCase().includes("already exists") || message.toLowerCase().includes("required")) {
      return NextResponse.json({ success: false, error: message }, { status: 400 });
    }
    if (isProbationSchemaMissing(error)) {
      return NextResponse.json({ success: false, error: "Probation review schema is not ready." }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
