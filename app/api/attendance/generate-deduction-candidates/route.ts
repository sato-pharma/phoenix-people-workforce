import { NextResponse } from "next/server";

import { generateAttendanceDeductionCandidates } from "@/lib/attendance/payroll-candidates";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "create");

    const payload = await request.json().catch(() => ({}));
    const { month } = payload as Record<string, unknown>;
    if (!month || typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) {
      throw validationError("month is required and must be in YYYY-MM format.");
    }

    const result = await generateAttendanceDeductionCandidates(month);
    return NextResponse.json(result);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Failed to generate deduction candidates.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
