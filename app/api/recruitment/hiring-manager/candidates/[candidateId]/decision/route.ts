import { NextResponse } from "next/server";

import {
  redactCandidateContact,
  revealPhoneToViewer,
} from "@/lib/recruitment/candidate-call-claims";
import { loadCallClaim, releaseCandidateCall } from "@/lib/recruitment/candidate-call-claims-db";
import { updateCandidateStatus } from "@/lib/recruitment/candidates";
import {
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  hiringManagerDecisionStatus,
  hiringManagerDecisions,
  isHiringManagerDecision,
} from "@/lib/recruitment/candidate-status";
import { isCandidateSentToCaller } from "@/lib/recruitment/hiring-manager-view";
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

/**
 * The manager's answer on a CV that was pushed straight to them.
 *
 * Until this route existed the push was one-way: a District Manager received the alert, opened the
 * CV, and had nowhere to say anything back — which is most of why 7 applications exist against 226
 * candidates. Two answers, mapped onto the candidate's own status vocabulary; the manager's words
 * travel with the decision as the status note.
 *
 * Gated on `hiring_interviews:update`, NOT `candidates:update`. That is not a shortcut: `candidates`
 * is hard-boundary-locked to Super Admin / Talent Acquisition and can never be granted to a District
 * Manager even by an override, so gating on it would refuse exactly the person this route is for.
 *
 * Scope is narrower here than on the sibling file routes. Those admit any candidate the caller can
 * reach through one of their own requisitions; this one requires the candidate to have been pushed
 * to THIS caller by name. Reading someone's CV and changing their status are different acts, and
 * only the second needs the recruiter to have deliberately asked this manager for an answer.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "update");
    const { candidateId } = await params;
    const body = await readJsonObject(request);

    const decision = str(body.decision);
    if (!decision || !isHiringManagerDecision(decision)) {
      return validationError(`Answer with one of: ${hiringManagerDecisions.join(", ")}.`);
    }

    const note = str(body.note);
    if (note && note.length > CANDIDATE_STATUS_NOTE_MAX_LENGTH) {
      return validationError(`Keep the note under ${CANDIDATE_STATUS_NOTE_MAX_LENGTH} characters.`);
    }
    // A refusal without a reason tells Talent Acquisition nothing, and the point of pushing a CV out
    // of the pool is to get back something worth reading. "Yes" needs no explaining; "no" does.
    if (decision === "not_interested" && !note) {
      return validationError("Add a short reason so the recruitment team knows why.");
    }

    if (!(await isCandidateSentToCaller(access, candidateId))) {
      return NextResponse.json(
        {
          error: "forbidden",
          message: "That candidate was not sent to you.",
          success: false,
        },
        { status: 403 },
      );
    }

    const candidate = await updateCandidateStatus(access, candidateId, hiringManagerDecisionStatus[decision], note);

    // A manager who has just skipped somebody has plainly stopped intending to phone them, so his
    // own reservation goes with the answer. Leaving it would lock the CV away from every other
    // manager with nobody working it — the one failure mode a claim can produce. It removes only HIS
    // row, so a CV reserved by somebody else is untouched, and it can never block the answer: the
    // decision is already written by this point, and a failed release must not turn a recorded Skip
    // into an error on his screen.
    if (decision === "not_interested" && access.hrId) {
      await releaseCandidateCall({ candidateId, managerHrId: access.hrId }).catch(() => undefined);
    }

    // The candidate this route hands back is the row as STORED, phone number and all, and a screen
    // that renders it from anywhere but the claim would print what the page took away. Redacted
    // against whatever claim now stands — which, after a Skip, is no longer his. Read AFTER the
    // release above, deliberately, so the answer reflects the state the manager is left in.
    const claim = await loadCallClaim(candidateId);
    return NextResponse.json({
      candidate: redactCandidateContact(candidate, revealPhoneToViewer(claim, access.hrId)),
      claim,
      success: true,
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to record your answer on that candidate.");
  }
}
