import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { checkFeedbackEligibility, getFeedbackForEmployee } from "@/lib/probation/feedback-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ hrId: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");

    const { hrId } = await params;
    const [submissions, eligibility] = await Promise.all([
      getFeedbackForEmployee(access, hrId).catch(() => []),
      checkFeedbackEligibility(access, hrId),
    ]);

    return NextResponse.json(
      { submissions, eligibility },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (isForbiddenError(err)) return NextResponse.json({ error: String(err) }, { status: 403 });
    if (err instanceof Error && err.message.includes("Forbidden")) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
