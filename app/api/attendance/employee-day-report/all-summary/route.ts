import { NextResponse } from "next/server";

import { getAllEmployeesFingerprintDeductionsSummary } from "@/lib/attendance/employee-day-report";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Company-wide confirmed-fingerprint-deductions summary for a date range — no employee picked.
 * Same Super Admin gate as the Employee Day-by-Day Report page and its decisions route, with
 * `deductions:approve` asserted beside it, exactly as the decisions route does.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin") {
      throw new Error("Forbidden: only Super Admin can view the company-wide fingerprint deductions summary.");
    }
    await assertPermission(access, "deductions", "approve");

    const url = new URL(request.url);
    const dateFrom = url.searchParams.get("dateFrom")?.trim() ?? "";
    const dateTo = url.searchParams.get("dateTo")?.trim() ?? "";
    if (!dateFrom || !dateTo) {
      return NextResponse.json(
        { error: "invalid_request", message: "dateFrom and dateTo are required." },
        { status: 400 },
      );
    }

    const rows = await getAllEmployeesFingerprintDeductionsSummary({ dateFromIso: dateFrom, dateToIso: dateTo });
    return NextResponse.json({ rows });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unexpected error.");
    const forbidden = message.startsWith("Forbidden:");
    return NextResponse.json(
      { error: forbidden ? "forbidden" : "invalid_request", message },
      { status: forbidden ? 403 : 400 },
    );
  }
}
