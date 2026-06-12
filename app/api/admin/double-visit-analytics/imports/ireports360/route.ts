import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildAndSaveDoubleVisitIReports360Import } from "@/lib/double-visit-analytics/service";
import { IReports360ApiError } from "@/lib/field-workforce-compliance/ireports360-client";
import { isIReports360Configured } from "@/lib/field-workforce-compliance/ireports360-config";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function validDate(value: unknown) {
  const text = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "double_visit_analytics", "import");
    if (!isIReports360Configured()) {
      return NextResponse.json({
        error: "ireports360_not_configured",
        message: "The iReports360 connection is not configured on the server.",
      }, { status: 409 });
    }

    const body = await request.json().catch(() => ({}));
    const dateFrom = validDate(body.dateFrom);
    const dateTo = validDate(body.dateTo);
    if (!dateFrom || !dateTo || dateTo < dateFrom) {
      return NextResponse.json({
        error: "invalid_date_range",
        message: "Provide a valid Double Visit date range.",
      }, { status: 400 });
    }

    const result = await buildAndSaveDoubleVisitIReports360Import({
      actorLoginId: access.loginId ?? access.hrId ?? "system",
      dateFrom,
      dateTo,
    });
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to import Double Visit data." }, { status: 403 });
    }
    if (error instanceof IReports360ApiError) {
      return NextResponse.json({ error: "ireports360_import_failed", message: error.message }, { status: error.status });
    }
    return NextResponse.json({
      error: "double_visit_ireports360_import_failed",
      message: error instanceof Error ? error.message : "Double Visit iReports360 import failed.",
    }, { status: 500 });
  }
}
