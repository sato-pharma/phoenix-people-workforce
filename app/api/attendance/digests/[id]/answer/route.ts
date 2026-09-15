import { NextResponse } from "next/server";

import { answerDigestLine, canOpenDigestPortal } from "@/lib/attendance/digest-service.ts";
import { isDeductionMethod } from "@/lib/attendance/digest-rules.ts";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The employee's answer for one day of a released week: `method` is "salary" or
 * "annual_balance", and `dispute: true` with a `reason` parks the day for the reviewer instead of
 * settling it. Self-scoped — answerDigestLine refuses any digest that is not the caller's own.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!(await canOpenDigestPortal(access).catch(() => false))) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    if (!access.hrId) throw validationError("No HR ID on session.");

    const { id: rawId } = await params;
    const digestId = Number(rawId);
    if (!Number.isInteger(digestId) || digestId <= 0) throw validationError("Invalid week id.");

    const payload = (await request.json().catch(() => ({}))) as {
      lineId?: unknown;
      method?: unknown;
      dispute?: unknown;
      reason?: unknown;
    };
    const lineId = Number(payload.lineId);
    if (!Number.isInteger(lineId) || lineId <= 0) throw validationError("Invalid day id.");
    // Not defaulted: guessing the method moves money or leave days the employee never chose.
    if (!isDeductionMethod(payload.method)) throw validationError("Choose salary or annual balance.");
    if (typeof payload.dispute !== "boolean") throw validationError("Say whether you want to dispute this day.");

    const result = await answerDigestLine({
      actorHrId: access.hrId,
      actorRole: String(access.role ?? ""),
      digestId,
      dispute: payload.dispute,
      disputeReason: typeof payload.reason === "string" ? payload.reason : null,
      lineId,
      method: payload.method,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Your answer could not be saved.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
