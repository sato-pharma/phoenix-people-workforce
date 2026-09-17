import { NextResponse } from "next/server";

import { canManageWeeklyReview, releaseWeek } from "@/lib/attendance/digest-service.ts";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Release the days of one week waiting now — the step that notifies employees. Owner decisions
 * 2026-09-15 (nothing reaches an employee until this is clicked) and 2026-09-17 (release any time;
 * later days go out in a second release). `seenLines` is every waiting day as the page showed it, so a
 * day that arrived after the page loaded is never released unseen. `digestId`, when sent, releases that one
 * employee only and leaves the others waiting (owner, 2026-09-17). The Super Admin only — a dispute
 * reviewer can see the week but cannot release it.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!canManageWeeklyReview(access)) {
      return NextResponse.json({ error: "forbidden", message: "Only the Super Admin can release a week." }, { status: 403 });
    }
    if (!access.hrId) throw validationError("No HR ID on session.");

    const payload = (await request.json().catch(() => ({}))) as {
      cycleKey?: unknown;
      weekIndex?: unknown;
      seenLines?: unknown;
      digestId?: unknown;
    };
    const cycleKey = String(payload.cycleKey ?? "");
    if (!/^\d{4}-\d{2}$/.test(cycleKey)) throw validationError("Invalid cycle.");
    const weekIndex = Number(payload.weekIndex);
    if (!Number.isInteger(weekIndex) || weekIndex < 1 || weekIndex > 5) throw validationError("Invalid week.");

    const result = await releaseWeek({
      actorHrId: access.hrId,
      actorRole: access.role ?? null,
      cycleKey,
      weekIndex,
      seenLines: payload.seenLines,
      digestId: payload.digestId,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "The week could not be released.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
