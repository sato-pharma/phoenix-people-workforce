import { NextResponse } from "next/server";

import { isUuid } from "@/lib/http/uuid";
import { FOLLOWUP_BULK_MAX, sendAskAgainMany } from "@/lib/recruitment/inbound/whatsapp-followup-template";
import { assertWorkspaceWorker } from "@/lib/recruitment/workspace/candidate-actions";
import { assertCandidatesVisible } from "@/lib/recruitment/workspace/fence";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A body larger than this is refused outright rather than read: a press sends to 50 at most. */
const MAX_IDS_IN_BODY = 500;

/**
 * "Ask again" for the ticked applicants: `{ candidateIds }` → `{ sent, skipped: [{ candidateId, reason }] }`.
 * Sent one after another, at most 50 a press (the rest are named in `skipped`), every refusal named.
 * A batch that names a candidate this viewer may not see is refused whole. Recruitment team only.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    assertWorkspaceWorker(access);

    const body = await readJsonObject(request);
    const raw = Array.isArray(body.candidateIds) ? body.candidateIds : null;
    if (!raw || raw.length === 0) return recruitmentProblem("Tick at least one candidate.", 400);
    if (raw.length > MAX_IDS_IN_BODY) {
      return recruitmentProblem(`Tick fewer candidates: ${FOLLOWUP_BULK_MAX} are asked at a time.`, 400);
    }
    const ids = Array.from(new Set(raw.map((value) => String(value ?? "").trim()))).filter(Boolean);
    const invalid = ids.filter((id) => !isUuid(id));
    const valid = ids.filter((id) => isUuid(id));
    await assertCandidatesVisible(access, valid);

    const result = await sendAskAgainMany(valid, access);
    return NextResponse.json({
      sent: result.sent,
      skipped: [...invalid.map((candidateId) => ({ candidateId, reason: "Candidate not found." })), ...result.skipped],
    });
  } catch (error) {
    return recruitmentApiError(error, "Could not ask them again on WhatsApp.");
  }
}
