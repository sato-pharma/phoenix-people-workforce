import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { releaseDailyLines } from "@/lib/daily-deductions/release.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Daily Deductions screen sends `{ rangeStart, rangeEnd, lines }` — the window (or the days the
 * lines carry) and the single deductions it is releasing, exactly as computed. Each line reaches the
 * service untouched (`z.unknown()` keeps every key) and is validated structurally there; `notes` is
 * optional and no screen sends it today.
 */
const ReleaseBodySchema = z.object({
  rangeStart: z.string().nullish(),
  rangeEnd: z.string().nullish(),
  lines: z.array(z.unknown()).nullish(),
  notes: z.string().nullish(),
});

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

    const parsed = await parseJsonBody(request, ReleaseBodySchema);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.message }, { status: 400 });
    }
    const body = parsed.data;
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
