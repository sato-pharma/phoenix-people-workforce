import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertDailyDeductionsReadActor } from "@/lib/daily-deductions/permissions.ts";
import { publishDailyTally } from "@/lib/daily-deductions/publish.ts";
import { listDailyPublications } from "@/lib/daily-deductions/service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PublishBody = {
  rangeStart?: unknown;
  rangeEnd?: unknown;
  lines?: unknown;
  notes?: unknown;
};

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

    const body = (await request.json()) as PublishBody;
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
