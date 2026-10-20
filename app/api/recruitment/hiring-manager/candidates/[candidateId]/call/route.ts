import { NextResponse } from "next/server";

import { canSeeAllRecruitment } from "@/lib/recruitment/access";
import {
  candidateCallRequests,
  isCandidateCallRequest,
  type CandidateCallRequest,
} from "@/lib/recruitment/candidate-call-claims";
import {
  claimCandidateCall,
  loadCallClaim,
  loadCandidateContact,
  releaseCandidateCall,
  skipCandidateForManager,
} from "@/lib/recruitment/candidate-call-claims-db";
import { isCandidateInViewerDistrictScope } from "@/lib/recruitment/district-manager-folders-db";
import { recordManagerCvOpen } from "@/lib/recruitment/manager-cv-engagement";
import {
  isCandidateInCallerRequisition,
  isCandidateSentToCaller,
} from "@/lib/recruitment/hiring-manager-view";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";
import type { AccessContext } from "@/lib/auth/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validationError(message: string) {
  return NextResponse.json({ error: "validation", message, success: false }, { status: 400 });
}

/**
 * MAY THIS CALLER RESERVE OR PASS ON THIS CV?
 *
 * DELIBERATELY NARROWER THAN THE FILE ROUTES, and narrower than the comment and folder routes too.
 * Those admit a National Sales Manager reading the CVs sitting with the managers below him, because
 * reading somebody's CV and commenting on it are things he was asked to do. Reserving one is not:
 * the owner's rule since 2026-08-30 is that the answer belongs to the manager the CV was sent to,
 * and a manager above him taking the call would be that same overwrite in a new shape. He sees WHO
 * reserved it, which is the whole thing he needs to know.
 *
 * So exactly three ways in, and they are the three lists a manager holds HIMSELF:
 *
 *   • a CV a recruiter pushed straight to him — isCandidateSentToCaller, the same check the decision
 *     route gates on, so "answer" and "reserve" cannot admit different people;
 *   • a CV in one of HIS OWN area folders — the suppression-BLIND check, so a manager who skipped a
 *     CV can still release a claim or take it back. isCandidateInViewerDistrict (the suppression-aware
 *     twin) would answer 403 on the second press, which reads as a fault rather than as a decision he
 *     already made;
 *   • a candidate on a requisition he owns — his own interview round. Easy to leave out, and leaving
 *     it out breaks the one list on the page that arrives by neither a push nor a folder: he would
 *     read "Hidden" where the phone number belongs on somebody he is booked to interview, and the
 *     button that reveals it would answer 403.
 */
async function assertCanAct(access: AccessContext, candidateId: string): Promise<void> {
  if (canSeeAllRecruitment(access)) return;
  if (await isCandidateSentToCaller(access, candidateId)) return;
  if (await isCandidateInViewerDistrictScope(access.hrId, candidateId)) return;
  if (await isCandidateInCallerRequisition(access, candidateId)) return;
  throw new Error("Forbidden: that CV was not sent to you and is not in one of your areas.");
}

/**
 * "I will call this candidate", "actually I won't", and "skip".
 *
 * The owner, 2026-09-09: *"have 2 buttons on every cv — I will call and Skip ... if pressed I will
 * call then every other manager receiving this CV when open the same CV shows that Ahmed will call
 * this CV."*
 *
 * ONE ROUTE FOR THREE VERBS, because they are one decision about one CV and they share one access
 * rule. Three endpoints would be three copies of `assertCanAct` to keep in step, and the day they
 * drift is the day one of them lets a manager reserve a CV he may not open.
 *
 * WHAT COMES BACK. `claim` is the claim now standing on the CV — the caller's own, somebody else's,
 * or null — so the card always redraws from the truth rather than from what it hoped had happened. A
 * refused claim answers 409 WITH the winning claim attached, which is what lets a losing press turn
 * straight into "Ahmed will call this candidate" instead of an error the manager has to dismiss.
 *
 * `phone` is present ONLY on the response to a claim the caller now holds. That is the one moment
 * the number may cross to a browser, and returning it here is what makes the reveal immediate — the
 * alternative is a page reload, on the screen where a manager has just committed to phoning
 * somebody. Every other response, including a refusal, carries no contact detail at all.
 *
 * Gated on `hiring_interviews:update`, like every sibling route under hiring-manager/, and NOT on
 * `candidates:update` — that resource is hard-boundary-locked to Super Admin and Talent Acquisition
 * and can never be granted to a District Manager, so gating on it would refuse the exact person this
 * route exists for.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "update");
    const { candidateId } = await params;
    await assertCandidateVisible(access, candidateId);

    const body = await readJsonObject(request);
    const action = str(body.action);
    if (!action || !isCandidateCallRequest(action)) {
      return validationError(`Ask for one of: ${candidateCallRequests.join(", ")}.`);
    }

    if (!access.hrId) {
      return validationError("Your account has no HR id, so a CV cannot be reserved against it.");
    }

    await assertCanAct(access, candidateId);

    const outcome = await run(action, candidateId, access.hrId, str(body.note));
    if (!outcome.ok) {
      // 409, not 400: nothing about the request is wrong — somebody else simply got there first, and
      // the card's job now is to show his name rather than to ask the manager to correct anything.
      return NextResponse.json(
        { claim: outcome.claim, error: "conflict", message: outcome.message, success: false },
        { status: 409 },
      );
    }

    const revealed = action === "will_call" && Boolean(outcome.claim);
    const contact = revealed ? await loadCandidateContact(candidateId) : null;

    // REVEALING THE NUMBER MARKS THE CV SEEN. The owner, 2026-09-13, removing the feedback lock:
    // *"when the manager request to view the number, then the number appear, and the CV is marked as
    // seen."* This is the same silent write a CV open makes (ats_candidate_views, under his own
    // HR_ID), so the engagement report counts it. Best-effort: a tracking write must never be the
    // reason the number fails to appear.
    if (revealed) {
      try {
        await recordManagerCvOpen({ candidateId, viewerHrId: access.hrId });
      } catch {
        /* the number is still revealed; the seen mark is advisory */
      }
    }

    return NextResponse.json({
      claim: outcome.claim,
      phone: contact?.phone ?? null,
      success: true,
      whatsapp: contact?.whatsapp ?? null,
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to record that on this CV.");
  }
}

function run(
  action: CandidateCallRequest,
  candidateId: string,
  managerHrId: string,
  note: string | null,
) {
  if (action === "will_call") return claimCandidateCall({ candidateId, managerHrId });
  if (action === "release") return releaseCandidateCall({ candidateId, managerHrId });
  return skipCandidateForManager({ candidateId, managerHrId, note });
}

/**
 * Who holds this CV, for a card that has just been opened out of a list that did not carry claims.
 *
 * Every screen in the portal is handed its claims with the list it renders, so nothing calls this
 * today. It exists because the alternative pattern — a card fetching its own claim on mount — is the
 * one that made the View CV button take fifteen seconds to appear on the team screen, and leaving a
 * read here makes it obvious that the list-level load is the deliberate choice rather than an
 * omission somebody should "fix" by adding a per-card fetch.
 */
export async function GET(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "read");
    const { candidateId } = await params;
    await assertCandidateVisible(access, candidateId);
    await assertCanAct(access, candidateId);
    return NextResponse.json({ claim: await loadCallClaim(candidateId), success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to read who has reserved this CV.");
  }
}
