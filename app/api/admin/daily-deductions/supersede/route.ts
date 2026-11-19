import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { supersedeDailyPublication } from "@/lib/daily-deductions/publish.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Daily Deductions screen's "Withdraw all" sends `{ publicationId }` — the active snapshot's id. */
const SupersedeBodySchema = z.object({
  publicationId: z.string().nullish(),
});

/** Withdraw the active running-tally snapshot without publishing a replacement. */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "approve");
    // assertDailyDeductionsPublishActor runs inside supersedeDailyPublication (Super Admin).

    const parsed = await parseJsonBody(request, SupersedeBodySchema);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.message }, { status: 400 });
    }
    const body = parsed.data;
    if (typeof body.publicationId !== "string" || !body.publicationId.trim()) {
      throw new Error("Validation: publicationId is required.");
    }

    const publication = await supersedeDailyPublication({ publicationId: body.publicationId, actor: access });
    return NextResponse.json({ success: true, publication });
  } catch (error) {
    return jsonError(error, "Failed to withdraw the daily deductions tally.");
  }
}
