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
    await assertPermission(access, "probation", "update");

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
