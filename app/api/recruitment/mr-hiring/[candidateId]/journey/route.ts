import { NextResponse } from "next/server";

import { recruitmentApiError, recruitmentProblem } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { isUuid } from "@/lib/http/uuid";
import { loadMrJourney } from "@/lib/recruitment/mr-hiring/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One Medical Rep candidate's whole hiring journey (§10): where they are, what this viewer may do
// next, and the timeline from the WhatsApp CV to the offer. Read by the HR Manager, Talent
// Acquisition and the CEO, and by every manager involved — on one of the candidate's interviews, sent
// the CV, or above the manager who was (`mayReadMrJourney`). Anyone else is told the candidate is not
// there. The NSM's proposed salary is removed on the server for everyone but the HR Manager, Talent
// Acquisition and the NSM who wrote it.
export async function GET(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) return recruitmentProblem("Sign in again to open the journey.", 401);
    const { candidateId } = await params;
    if (!isUuid(candidateId)) return recruitmentProblem("Candidate not found.", 404);
    await assertCandidateVisible(access, candidateId);
    const journey = await loadMrJourney(access, candidateId);
    return NextResponse.json({ ...journey, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the hiring journey.");
  }
}
