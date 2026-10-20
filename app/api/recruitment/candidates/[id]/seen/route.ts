import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { markCandidateSeen } from "@/lib/recruitment/candidate-views";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "I have now read this CV."
 *
 * Fired by the screening queue as a candidate's document actually renders, not by a button — the
 * whole complaint this answers is that reviewing 434 CVs already costs too many clicks, and a
 * "mark as read" control would have added a 435th. It is therefore best-effort by design: the
 * caller does not await it before showing the next candidate, and a failure here must never
 * interrupt somebody mid-queue.
 *
 * Permission is deliberately `candidates: read` rather than `update`. Recording that you looked at
 * something is not a change to the candidate — it writes to your own view history, scoped to your
 * own HR_ID by the service, and someone allowed to read a CV is by definition allowed to have read
 * it. Requiring `update` would have locked read-only reviewers out of the one feature that stops
 * them re-reading the same files.
 *
 * It is still a mutation, so it is still same-origin gated: the route is covered by the
 * `/api/recruitment/candidates/**` entry in src/lib/security/access-registry.ts, which declares
 * `csrfRequired: true`, and that registry entry obliges the assertSameOriginMutation call below —
 * a test greps this source for it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    const { id } = await params;
    await assertCandidateVisible(access, id);

    // Scoped to the CALLER, never to an HR_ID from the body. "Have I seen this" is a question
    // about the person asking it, and accepting a viewer id from a request would let one person
    // silently mark another's queue as read.
    // `claim: true` ONLY here. This is the screening beacon — the screener has the CV open — and it
    // is the collision this lease exists to prevent. The manager paths that also reach
    // markCandidateSeen deliberately do not claim: a manager reading a CV already sent to them is
    // not competing for screening work, and claiming for them would tell a screener to pick
    // another CV on account of somebody who is not screening.
    const view = await markCandidateSeen({ candidateId: id, claim: true, viewerHrId: access.hrId });

    // A null view means either "no HR_ID on this session" (a dev-preview login with none) or "the
    // migration has not reached this database yet". Neither is an error the screener can act on,
    // and neither should colour a CV red mid-queue, so both report success with nothing recorded.
    return NextResponse.json({ recorded: Boolean(view), success: true, view });
  } catch (error) {
    return recruitmentApiError(error, "Failed to record that this CV was read.");
  }
}
