import { NextResponse } from "next/server";

import { isAuthorizedDisputeReviewer } from "@/lib/attendance/digest-read";
import { setDayAttendanceDecision } from "@/lib/attendance/settlement-service";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!access.hrId) throw validationError("No HR ID on session.");

    // Same reviewer gate as digest-review approve/correct — only HR Manager and
    // Super Admin may make a direct day-level attendance decision.
    const authorized = await isAuthorizedDisputeReviewer(access.hrId, access.role === "Super Admin");
    if (!authorized) {
      return NextResponse.json(
        { error: "forbidden", message: "You are not an authorized attendance reviewer." },
        { status: 403 },
      );
    }

    const payload = (await request.json().catch(() => ({}))) as {
      employeeHrId?: unknown;
      dateIso?: unknown;
      deductionDays?: unknown;
      deductionValue?: unknown;
      reason?: unknown;
    };
    if (typeof payload.employeeHrId !== "string" || !payload.employeeHrId.trim()) {
      throw validationError("employeeHrId is required.");
    }
    if (typeof payload.dateIso !== "string" || !payload.dateIso.trim()) {
      throw validationError("dateIso is required.");
    }
    if (typeof payload.reason !== "string" || !payload.reason.trim()) {
      throw validationError("A reason is required.");
    }
    const deductionDays = Number(payload.deductionDays ?? 0);
    const deductionValue = Number(payload.deductionValue ?? 0);
    if (!Number.isFinite(deductionDays) || deductionDays < 0) {
      throw validationError("deductionDays must be a non-negative number.");
    }
    if (!Number.isFinite(deductionValue) || deductionValue < 0) {
      throw validationError("deductionValue must be a non-negative number.");
    }

    const result = await setDayAttendanceDecision({
      actorHrId: access.hrId,
      dateIso: payload.dateIso.trim(),
      deductionDays,
      deductionValue,
      employeeHrId: payload.employeeHrId.trim(),
      reason: payload.reason.trim(),
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Attendance day decision failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
