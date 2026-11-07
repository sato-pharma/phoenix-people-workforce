import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError, recruitmentProblem } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { isUuid } from "@/lib/http/uuid";
import { recordMrRecommendation } from "@/lib/recruitment/mr-hiring/record";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The NSM's recommendation after the final interview (§8): make an offer or keep as backup, with the
// proposed salary and joining date. Only the NSM on the candidate's final interview (or the HR
// Manager) may write it — `mayRecommend` decides inside the domain before anything is written. The HR
// Manager is then told the final decision is his; the salary never travels in that notice.
export async function POST(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) return recruitmentProblem("Sign in again to write the recommendation.", 401);
    const { candidateId } = await params;
    if (!isUuid(candidateId)) return recruitmentProblem("Candidate not found.", 404);
    await assertCandidateVisible(access, candidateId);
    const result = await recordMrRecommendation(access, candidateId, await readJsonObject(request));
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not save the recommendation.");
  }
}
