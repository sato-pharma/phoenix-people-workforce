import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { releaseDailyLines } from "@/lib/daily-deductions/release.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReleaseBody = {
  rangeStart?: unknown;
  rangeEnd?: unknown;
  lines?: unknown;
  notes?: unknown;
};

/**
 * Release one deduction, several, or a whole employee's. The lines are the figures the owner saw
 * on screen (computed by the compute route); they are validated structurally here and MERGED into
 * the active snapshot by phx_release_daily_deduction_lines. Every other released line is untouched.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "approve");
    // assertDailyDeductionsPublishActor runs inside releaseDailyLines (Super Admin).

    const body = (await request.json()) as ReleaseBody;
    if (typeof body.rangeStart !== "string" || typeof body.rangeEnd !== "string") {
      throw new Error("Validation: rangeStart and rangeEnd are required (YYYY-MM-DD).");
    }
    if (!Array.isArray(body.lines)) {
      throw new Error("Validation: lines must be an array of the selected tally rows.");
    }

    const result = await releaseDailyLines({
      rangeStart: body.rangeStart,
      rangeEnd: body.rangeEnd,
      lines: body.lines,
      notes: typeof body.notes === "string" ? body.notes : null,
      actor: access,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return jsonError(error, "Failed to release the selected daily deductions.");
  }
}
