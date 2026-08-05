import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { submitFeedback, type FeedbackRecommendation } from "@/lib/probation/feedback-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    // Coarse gate only. The fine boundary is submitFeedback -> checkFeedbackEligibility ->
    // resolveSubmitterRole, which admits a caller only as this employee's own direct manager
    // or as NSM / TM / PM-GPM / Talent Acquisition, and enforces the per-cycle / once-only
    // limit. Same split the SFE assessment uses (see the probation grant comments in
    // src/lib/auth/permissions.ts).
    //
    // This asserted `probation:update` until 2026-08-05, which NO role holding the Feedback
    // button actually has — the button renders for 8 roles, all of which hold probation:["read"],
    // while `update` is Super Admin-only and Super Admin is not shown the button. The feature
    // had therefore never recorded a single submission. Widening this to `update` for those 8
    // roles would also have handed them probation config, backfill and DV-checkbox writes, which
    // is why the coarse gate moved down instead of the grant moving up (owner-approved).
    await assertPermission(access, "probation", "read");

    const body = await request.json();
    const { employeeHrId, feedbackText, recommendation } = body as {
      employeeHrId?: string;
      feedbackText?: string;
      recommendation?: string;
    };

    if (!employeeHrId || !feedbackText || !recommendation) {
      return NextResponse.json({ error: "employeeHrId, feedbackText, and recommendation are required." }, { status: 400 });
    }

    const validRecommendations: FeedbackRecommendation[] = ["recommend_pass", "recommend_dismissal", "not_sure_yet"];
    if (!validRecommendations.includes(recommendation as FeedbackRecommendation)) {
      return NextResponse.json({ error: "Invalid recommendation value." }, { status: 400 });
    }

    const submission = await submitFeedback(access, {
      employeeHrId,
      feedbackText,
      recommendation: recommendation as FeedbackRecommendation,
    });

    return NextResponse.json({ submission }, { status: 201 });
  } catch (err) {
    if (isForbiddenError(err)) return NextResponse.json({ error: String(err) }, { status: 403 });
    if (err instanceof Error && err.message.includes("Forbidden")) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
