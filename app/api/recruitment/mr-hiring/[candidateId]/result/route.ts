import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError, recruitmentProblem } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { isUuid } from "@/lib/http/uuid";
import { recordMrStepResult } from "@/lib/recruitment/mr-hiring/record";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Record a result at one step of the Medical Rep hiring workflow: HR screening, an interview, HR's
// decision without the DSM's feedback, or the HR Manager's final decision. WHO may record WHICH step
// is decided inside the domain (`mayRecordStep`, src/lib/recruitment/mr-hiring/access.ts) before the
// first write — the DSM on his own interview, HR on its own steps, the HR Manager alone on the final
// decision. A result is a new row, never an edit. Nothing is ever sent to the candidate.
export async function POST(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) return recruitmentProblem("Sign in again to record a result.", 401);
    const { candidateId } = await params;
    if (!isUuid(candidateId)) return recruitmentProblem("Candidate not found.", 404);
    await assertCandidateVisible(access, candidateId);
    const result = await recordMrStepResult(access, candidateId, await readJsonObject(request));
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not record the result.");
  }
}
