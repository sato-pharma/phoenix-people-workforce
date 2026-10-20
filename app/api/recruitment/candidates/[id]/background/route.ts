import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import {
  backgroundConfirmationOutcomes,
  isBackgroundConfirmationOutcome,
} from "@/lib/recruitment/background-review";
import { confirmCandidateBackground } from "@/lib/recruitment/candidates";
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
 * "I have read this CV — this graduate is / is not one of the five disciplines."
 *
 * The owner, 2026-08-31: *"anyone non eligible, you will make the admin be able to check first
 * their CV and confirm."* This is that confirm.
 *
 * `candidates: update`, matching the folder route beside it, because it is the same weight of
 * change: answering `paramedical` files the CV onto the Paramedical shelf in the same call and
 * takes it out of every district manager's folders, while answering `eligible` starts sending it to
 * them. Neither belongs behind a `read` permission.
 *
 * THE ANSWER IS VALIDATED AGAINST THE SAME LIST THE DATABASE HOLDS. `unknown` is deliberately not
 * accepted: it is what the rule says when it cannot tell, and an admin who has opened the document
 * and still cannot tell has not confirmed anything — that row stays in the queue rather than
 * acquiring a third state nobody can act on.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");

    const { id } = await params;
    await assertCandidateVisible(access, id);
    const candidateId = str(id);
    if (!candidateId) {
      return NextResponse.json(
        { error: "validation", message: "Which candidate?", success: false },
        { status: 400 },
      );
    }

    const body = await readJsonObject(request);
    const outcome = str(body.outcome);
    if (!isBackgroundConfirmationOutcome(outcome)) {
      return NextResponse.json(
        {
          error: "validation",
          message: `An answer must be one of: ${backgroundConfirmationOutcomes.join(", ")}.`,
          success: false,
        },
        { status: 400 },
      );
    }

    const candidate = await confirmCandidateBackground(access, candidateId, outcome);
    return NextResponse.json({ candidate, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not record that answer.");
  }
}
