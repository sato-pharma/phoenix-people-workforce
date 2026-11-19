import { NextResponse } from "next/server";
import { z } from "zod";

import { canReviewDisputes, reviewDispute } from "@/lib/attendance/digest-service.ts";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The dispute review inbox sends `{ uphold, notes }` — a boolean and the reviewer's note ("" when
 * blank). `uphold` is optional here only so its absence keeps the route's own refusal below: it is
 * never defaulted.
 */
const ReviewBodySchema = z.object({
  uphold: z.boolean().nullish(),
  notes: z.string().nullish(),
});

export async function POST(request: Request, { params }: { params: Promise<{ lineId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!(await canReviewDisputes(access))) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    if (!access.hrId) throw validationError("No HR ID on session.");

    const { lineId: rawLineId } = await params;
    const lineId = Number(rawLineId);
    if (!Number.isInteger(lineId) || lineId <= 0) throw validationError("Invalid line id.");

    const parsed = await parseJsonBody(request, ReviewBodySchema, { fallback: {} });
    if (!parsed.ok) throw validationError(parsed.message);
    const payload = parsed.data;
    if (typeof payload.uphold !== "boolean") {
      // Not defaulted: guessing this wrong either charges someone who was covered or
      // waives a real deduction, and both look identical afterwards.
      throw validationError("`uphold` must be true or false.");
    }

    const result = await reviewDispute({
      lineId,
      notes: typeof payload.notes === "string" ? payload.notes : null,
      reviewerHrId: access.hrId,
      reviewerRole: String(access.role ?? ""),
      uphold: payload.uphold,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Attendance dispute review failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
