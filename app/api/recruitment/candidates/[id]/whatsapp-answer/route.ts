import { NextResponse } from "next/server";
import { assertWorkspaceWorker } from "@/lib/recruitment/workspace/candidate-actions";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";
import { typedRoleRefusal } from "@/lib/recruitment/workspace/typed-role-filing";

import { roleFamilyForTypedRole, saveCandidateWhatsAppAnswer } from "@/lib/recruitment/whatsapp-answer-edit";
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
 *
 * TWO MORE LOCKS, because this write can FILE a person (the role answer re-files them in a tab):
 * the workspace's own worker gate, which refuses the CEO's read-only seat like every other workspace
 * write, and — for the role answer — the tab the typed role would file them in, which must be one the
 * reader may file into (`typedRoleRefusal`), so the Talent Acquisition seat cannot type her way into an
 * HR tab she is never shown.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const viewer = assertWorkspaceWorker(access);

    const { id } = await params;
    await assertCandidateVisible(access, id);
    const candidateId = str(id);
    if (!candidateId) return recruitmentProblem("Which candidate?", 400);

    const body = await readJsonObject(request);
    const key = str(body.key);
    if (!key) return recruitmentProblem("Which question is this answer for?", 400);
    // Refused here, before any read, so the reader gets the sentence rather than "something went wrong".
    const check = whatsAppAnswerEditPayload(key, body.value ?? null, {});
    if (!check.ok) return recruitmentProblem(check.message, 400);
    // The role answer files the person in the tab its family maps to: refused for a tab this reader may not file into.
    if (key === "job_title") {
      const typedRole = typeof body.value === "string" ? body.value : null;
      const refusal = typedRoleRefusal(viewer, roleFamilyForTypedRole(typedRole));
      if (refusal) return recruitmentProblem(refusal, 400);
    }

    // Who typed it: the "added by HR" mark and the audit row both need the HR id (owner, 2026-10-20).
    const candidate = await saveCandidateWhatsAppAnswer(candidateId, key, body.value ?? null, {
      hrId: access.hrId ?? null,
      loginId: access.loginId ?? null,
    });
    return NextResponse.json({ candidate, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not save that answer.");
  }
}
