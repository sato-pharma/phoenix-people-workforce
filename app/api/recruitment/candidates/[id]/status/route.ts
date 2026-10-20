import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { updateCandidateStatus } from "@/lib/recruitment/candidates";
import {
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  candidateStatuses,
  normalizeCandidateStatus,
} from "@/lib/recruitment/candidate-status";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validationError(message: string) {
  return NextResponse.json({ error: "validation", message, success: false }, { status: 400 });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const { id } = await params;
    await assertCandidateVisible(access, id);
    const body = await readJsonObject(request);

    const status = str(body.status);
    if (!status) return validationError("Status is required.");
    // The vocabulary is enforced HERE because this is the only path a browser can write a status
    // through — the column itself is still plain text with no CHECK constraint, on purpose (see
    // src/lib/recruitment/candidate-status.ts). Validating at the boundary is also what makes this
    // a 400 rather than a 500: updateCandidateStatus keeps its own defensive check, but a service
    // throwing is mapped to "something went wrong", which is the wrong thing to tell a caller who
    // simply sent a status that does not exist.
    if (!normalizeCandidateStatus(status)) {
      return validationError(`"${status}" is not a candidate status. Use one of: ${candidateStatuses.join(", ")}.`);
    }

    const note = str(body.note);
    if (note && note.length > CANDIDATE_STATUS_NOTE_MAX_LENGTH) {
      return validationError(`Keep the note under ${CANDIDATE_STATUS_NOTE_MAX_LENGTH} characters.`);
    }

    const candidate = await updateCandidateStatus(access, id, status, note);
    return NextResponse.json({ candidate, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to update candidate status.");
  }
}
