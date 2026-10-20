import { NextResponse } from "next/server";

import { isUuid } from "@/lib/http/uuid";
import { sendAskAgain } from "@/lib/recruitment/inbound/whatsapp-followup-template";
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
 * "Ask again" for one applicant (owner, 2026-10-20): the approved WhatsApp template
 * `phx_application_followup` asks them to come back and answer the questions they left blank. Their
 * reply opens the 24-hour window and the bot carries on where their answers stop.
 *
 * `{ sent, reason }` — a refusal (template not approved yet, a forwarder's number, closed, asked in
 * the last day, nothing missing) is a sentence HR reads, never an error. Recruitment team only.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    assertWorkspaceWorker(access);
    const { id } = await params;
    if (!isUuid(id)) return recruitmentProblem(CANDIDATE_NOT_FOUND, 404);
    await assertCandidateVisible(access, id);
    return NextResponse.json(await sendAskAgain(id, access));
  } catch (error) {
    return recruitmentApiError(error, "Could not ask them again on WhatsApp.");
  }
}
