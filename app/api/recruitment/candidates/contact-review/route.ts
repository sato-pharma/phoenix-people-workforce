import { NextResponse } from "next/server";
import { assertCandidatesVisible, fenceRowsByCandidate } from "@/lib/recruitment/workspace/fence";

import { applyContactProposals, listContactReviewQueue } from "@/lib/recruitment/contact-review-service";
import {
  assertSameOriginMutation,
  bool,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The unreachable pool, and what their own CVs say about how to reach them.
 *
 * Measured on production 2026-08-21: 250 of 549 candidates had neither an email nor a phone, and
 * 219 of those had one or both already extracted and sitting unread in the extraction table. The
 * unattended writer (cv-auto-apply.ts) is right to refuse email — it decides de-duplication — so
 * this is the attended path that closes the same gap with a human in it.
 */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is not on her queue.
    const rows = await fenceRowsByCandidate(access, await listContactReviewQueue(), (row) => row.candidateId);
    return NextResponse.json({ rows, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the contact-details review list.");
  }
}

/**
 * Accept the proposed contact details for the named candidates.
 *
 * The body carries candidate IDs ONLY. Every value written is re-derived server-side from the
 * stored extraction, so this cannot be used to write an arbitrary email or phone onto a candidate
 * — which matters because the two columns it fills are both dedupe-deciding.
 *
 * `highConfidenceOnly` is what the "accept all" button sends. Whatever it leaves behind comes back
 * in `skipped` with a reason rather than vanishing from the count.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const body = await readJsonObject(request);

    const raw = Array.isArray(body.candidateIds) ? body.candidateIds : [];
    const candidateIds = raw.map((value) => str(value)).filter((value): value is string => Boolean(value));
    if (candidateIds.length === 0) {
      return NextResponse.json(
        { error: "validation", message: "Choose at least one candidate.", success: false },
        { status: 400 },
      );
    }

    await assertCandidatesVisible(access, candidateIds);
    const result = await applyContactProposals({
      candidateIds,
      highConfidenceOnly: bool(body.highConfidenceOnly) ?? false,
    });
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to save those contact details.");
  }
}
