import { NextResponse } from "next/server";

import { attachCandidateToRequisition } from "@/lib/recruitment/requisition-attach";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The screening page's one press: attach this CV to an open requisition (owner, 2026-10-16 — "by
 * one click from admin or TA the CV is requisitioned"). `candidates:update`, which is hard-locked to
 * Super Admin and Talent Acquisition; the service checks the role again in words.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const { id } = await params;
    const body = await readJsonObject(request);
    const requisitionId = str(body.requisitionId);
    if (!requisitionId) {
      return NextResponse.json(
        { error: "validation", message: "Choose the requisition to attach this CV to.", success: false },
        { status: 400 },
      );
    }
    const result = await attachCandidateToRequisition(access, { candidateId: id, requisitionId });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return recruitmentApiError(error, "Failed to attach the CV to the requisition.");
  }
}
