import { NextResponse } from "next/server";

import { sendCandidateToManager } from "@/lib/recruitment/candidates";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send a candidate to a manager with no position attached.
 *
 * The sibling route under applications/[id] needs an application, an application needs a
 * requisition, and a requisition needs a job title, line, area, seat and owner. Measured in
 * production on 2026-08-15, that ceremony is why 214 of 221 candidates had never been shown to
 * anyone. This route is the short path: a candidate, a manager, done.
 *
 * The pickable managers are rendered from a server prop, so there is no GET twin here — but the
 * posted HR_ID is still re-validated against that same list inside sendCandidateToManager, because
 * anything arriving in a request body is user input however the form was drawn.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { managerHrId?: unknown };
    const managerHrId = typeof body.managerHrId === "string" ? body.managerHrId.trim() : "";
    if (!managerHrId) {
      return NextResponse.json({ error: "Choose the manager to send this candidate to.", success: false }, { status: 400 });
    }
    const result = await sendCandidateToManager(access, id, managerHrId);
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to send the candidate to that manager.");
  }
}
