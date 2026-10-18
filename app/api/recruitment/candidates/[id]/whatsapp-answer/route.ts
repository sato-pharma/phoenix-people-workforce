import { NextResponse } from "next/server";

import { saveCandidateWhatsAppAnswer } from "@/lib/recruitment/whatsapp-answer-edit";
import { whatsAppAnswerEditPayload } from "@/lib/recruitment/whatsapp-answer-edit-rules";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Edit, or fill in, one of a candidate's WhatsApp answers from the pool (owner, 2026-10-19 — "make
 * me able to edit or add a missing field and full control"). The rules are whatsapp-answer-edit-rules.ts.
 *
 * `candidates: update`, the grant hard-locked to Super Admin and Talent Acquisition, the same as every
 * other change to a record from the pool. Body: `{ key, value }` — `key` is the question's answer key
 * (`background`, `extra:oc_cairo`, …), and an empty or null `value` clears that answer.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    await requireRecruitmentAccess(request, "candidates", "update");

    const { id } = await params;
    const candidateId = str(id);
    if (!candidateId) return recruitmentProblem("Which candidate?", 400);

    const body = await readJsonObject(request);
    const key = str(body.key);
    if (!key) return recruitmentProblem("Which question is this answer for?", 400);
    // Refused here, before any read, so the reader gets the sentence rather than "something went wrong".
    const check = whatsAppAnswerEditPayload(key, body.value ?? null, {});
    if (!check.ok) return recruitmentProblem(check.message, 400);

    const candidate = await saveCandidateWhatsAppAnswer(candidateId, key, body.value ?? null);
    return NextResponse.json({ candidate, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not save that answer.");
  }
}
