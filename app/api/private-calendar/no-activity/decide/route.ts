import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { decideNoActivityDay, decideNoActivityDaysBulk } from "@/lib/private-calendar/no-activity-clarifications";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseResolution(value: unknown) {
  return value === "deducted" || value === "not_deducted" ? value : null;
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const resolution = parseResolution(body.resolution);
    if (!resolution) throw validationError("resolution must be 'deducted' or 'not_deducted'.");
    const adminNote = String(body.adminNote ?? "");

    if (Array.isArray(body.items)) {
      const items = body.items.map((item: Record<string, unknown>) => ({
        activityDate: String(item.activityDate ?? ""),
        employeeHrId: String(item.employeeHrId ?? ""),
        employeeName: typeof item.employeeName === "string" ? item.employeeName : null,
      }));
      const results = await decideNoActivityDaysBulk(access, { adminNote, items, resolution });
      return NextResponse.json({ data: results, success: true });
    }

    const clarification = await decideNoActivityDay(access, {
      activityDate: String(body.activityDate ?? ""),
      adminNote,
      employeeHrId: String(body.employeeHrId ?? ""),
      employeeName: typeof body.employeeName === "string" ? body.employeeName : null,
      resolution,
    });
    return NextResponse.json({ data: clarification, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to decide this No Activity day.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
