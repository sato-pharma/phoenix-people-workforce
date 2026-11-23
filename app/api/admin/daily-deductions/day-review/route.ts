import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { loadDayReviewRecord, pushDayReviewDeduction } from "@/lib/daily-deductions/day-review-service.ts";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daily Deductions — deduct a day by hand. GET `?employeeHrId&date` reads what Phoenix holds for that
 * person on that day, the deductions already on it and its price; POST pushes one day (or half a day)
 * with the comment the employee reads. Super Admin only — the service checks the actor on both.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "create");
    const url = new URL(request.url);
    const record = await loadDayReviewRecord({
      access,
      employeeHrId: url.searchParams.get("employeeHrId") ?? "",
      date: url.searchParams.get("date") ?? "",
    });
    return NextResponse.json({ success: true, record });
  } catch (error) {
    return jsonError(error, "Failed to read that employee's day.");
  }
}

/** The panel sends exactly these four; the service validates the size, the comment and the day. */
const PushBodySchema = z.object({
  employeeHrId: z.string(),
  date: z.string(),
  fraction: z.number(),
  comment: z.string(),
});

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "create");

    const parsed = await parseJsonBody(request, PushBodySchema);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.message }, { status: 400 });
    }
    const result = await pushDayReviewDeduction({ access, ...parsed.data });
    return NextResponse.json({ success: true, result });
  } catch (error) {
    return jsonError(error, "Failed to push the deduction for that day.");
  }
}
