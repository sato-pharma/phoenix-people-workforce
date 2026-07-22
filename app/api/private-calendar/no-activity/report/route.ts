import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { resolveCopilotCycleWindow } from "@/lib/payroll/copilot/deductions-review";
import { getCompanyNoActivityReport } from "@/lib/private-calendar/no-activity-clarifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const year = Number(url.searchParams.get("year"));
    const month = Number(url.searchParams.get("month"));
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      throw validationError("year and month query params are required.");
    }
    const cycle = await resolveCopilotCycleWindow({ month, year });
    const rows = await getCompanyNoActivityReport(access, { end: cycle.endIso, start: cycle.startIso });
    return NextResponse.json({ cycle, data: rows, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to load the No Activity Days report.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
