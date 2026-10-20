import { NextResponse } from "next/server";

import { isUuid } from "@/lib/http/uuid";
import { rejectionMessageAvailability, sendRejectionMessage } from "@/lib/recruitment/inbound/whatsapp-rejection-message";
import { assertWorkspaceWorker } from "@/lib/recruitment/workspace/candidate-actions";
import { assertCandidateVisible, CANDIDATE_NOT_FOUND } from "@/lib/recruitment/workspace/fence";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The "sorry" message for a rejected applicant on WhatsApp (owner, 2026-10-20). GET says whether it
 * can be sent now, why not, and the words it would send — the button is drawn from this. POST sends
 * it. Never automatic: the rejection has its own Undo, a WhatsApp message has none.
 *
 * Every refusal is a sentence HR reads (`{ sent: false, reason }`, 200), not an error: "they never
 * wrote to us on WhatsApp", "the 24-hour window has closed", "their number sent CVs for several
 * people". Gated as the other workspace changes are — the recruitment team only.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    assertWorkspaceWorker(access);
    const { id } = await params;
    if (!isUuid(id)) return recruitmentProblem(CANDIDATE_NOT_FOUND, 404);
    await assertCandidateVisible(access, id);
    return NextResponse.json(await rejectionMessageAvailability(id));
  } catch (error) {
    return recruitmentApiError(error, "Could not check whether the message can be sent.");
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    assertWorkspaceWorker(access);
    const { id } = await params;
    if (!isUuid(id)) return recruitmentProblem(CANDIDATE_NOT_FOUND, 404);
    await assertCandidateVisible(access, id);

    const hrId = access.hrId?.trim() || access.loginId?.trim() || null;
    if (!hrId) return recruitmentProblem("Your account has no HR record, so the message cannot be sent in your name.", 403);
    return NextResponse.json(await sendRejectionMessage(id, { hrId }));
  } catch (error) {
    return recruitmentApiError(error, "Could not send the message.");
  }
}
