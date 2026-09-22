import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { supersedeDailyPublication } from "@/lib/daily-deductions/publish.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SupersedeBody = {
  publicationId?: unknown;
};

/** Withdraw the active running-tally snapshot without publishing a replacement. */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "approve");
    // assertDailyDeductionsPublishActor runs inside supersedeDailyPublication (Super Admin).

    const body = (await request.json()) as SupersedeBody;
    if (typeof body.publicationId !== "string" || !body.publicationId.trim()) {
      throw new Error("Validation: publicationId is required.");
    }

    const publication = await supersedeDailyPublication({ publicationId: body.publicationId, actor: access });
    return NextResponse.json({ success: true, publication });
  } catch (error) {
    return jsonError(error, "Failed to withdraw the daily deductions tally.");
  }
}
