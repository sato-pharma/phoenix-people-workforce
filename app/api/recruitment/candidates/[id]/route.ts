import { NextResponse } from "next/server";

import { deleteCandidate, getCandidateProfile } from "@/lib/recruitment/candidates";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRecruitmentAccess(request, "candidates", "read");
    const { id } = await params;
    const profile = await getCandidateProfile(id);
    if (!profile) {
      return NextResponse.json({ error: "not_found", message: "Candidate not found.", success: false }, { status: 404 });
    }
    return NextResponse.json({ success: true, profile });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load candidate profile.");
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "delete");
    const { id } = await params;
    await deleteCandidate(access, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to delete candidate.");
  }
}
