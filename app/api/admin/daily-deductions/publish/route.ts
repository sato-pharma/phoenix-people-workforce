import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertDailyDeductionsReadActor } from "@/lib/daily-deductions/permissions.ts";
import { publishDailyTally } from "@/lib/daily-deductions/publish.ts";
import { listDailyPublications } from "@/lib/daily-deductions/service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `{ rangeStart, rangeEnd, lines, notes? }`. No screen posts here any more (the page releases one line
 * at a time through /release), so the shape is the route's own: each line goes to the service exactly
 * as sent — `z.unknown()` keeps every key — and is validated structurally there.
 */
const PublishBodySchema = z.object({
  rangeStart: z.string().nullish(),
  rangeEnd: z.string().nullish(),
  lines: z.array(z.unknown()).nullish(),
  notes: z.string().nullish(),
});

/**
 * The owner's publish click. The lines are the reviewed running tally he saw on
 * screen (computed by the compute route, one connector at a time); they are
 * validated structurally here and written atomically by phx_publish_daily_deductions.
 * No re-scan on this request — that is deliberate (see publish.ts).
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "approve");
    // assertDailyDeductionsPublishActor runs inside publishDailyTally (Super Admin).

    const parsed = await parseJsonBody(request, PublishBodySchema);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.message }, { status: 400 });
    }
    const body = parsed.data;
    if (typeof body.rangeStart !== "string" || typeof body.rangeEnd !== "string") {
      throw new Error("Validation: rangeStart and rangeEnd are required (YYYY-MM-DD).");
    }
    if (!Array.isArray(body.lines)) {
      throw new Error("Validation: lines must be an array of the reviewed tally rows.");
    }

    const result = await publishDailyTally({
      rangeStart: body.rangeStart,
      rangeEnd: body.rangeEnd,
      lines: body.lines,
      notes: typeof body.notes === "string" ? body.notes : null,
      actor: access,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return jsonError(error, "Failed to publish the daily deductions tally.");
  }
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");
    // A publication carries every published line's employee and amount.
    assertDailyDeductionsReadActor(access);

    const publications = await listDailyPublications();
    return NextResponse.json({ success: true, publications });
  } catch (error) {
    return jsonError(error, "Failed to load the daily deductions publications.");
  }
}
