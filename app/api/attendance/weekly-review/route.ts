import { NextResponse } from "next/server";

import { canReviewDisputes, listReviewWeeks, loadReviewWeek } from "@/lib/attendance/digest-service.ts";
import { pickDefaultReviewWeek } from "@/lib/attendance/digest-rules.ts";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The admin review: the weeks to pick from, and one week in full — the one asked for
 * (`?cycleKey=YYYY-MM&weekIndex=1..4`), or the newest waiting for release. Super Admin or a named
 * reviewer only — this lists every employee's flagged days.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!(await canReviewDisputes(access).catch(() => false))) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }

    const params = new URL(request.url).searchParams;
    const rawCycleKey = params.get("cycleKey");
    const rawWeekIndex = params.get("weekIndex");
    const weeks = await listReviewWeeks();
    let chosen: { cycleKey: string; weekIndex: number } | null = pickDefaultReviewWeek(weeks);
    if (rawCycleKey !== null || rawWeekIndex !== null) {
      const weekIndex = Number(rawWeekIndex);
      if (!/^\d{4}-\d{2}$/.test(rawCycleKey ?? "") || !Number.isInteger(weekIndex) || weekIndex < 1 || weekIndex > 4) {
        throw validationError("Invalid week.");
      }
      chosen = { cycleKey: String(rawCycleKey), weekIndex };
    }
    const week = chosen ? await loadReviewWeek(chosen) : null;
    return NextResponse.json({ weeks, week });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "The weekly attendance review failed to load.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
