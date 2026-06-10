import { NextResponse } from "next/server";

import { generateMonthlyAttendanceSummaryWorkbook } from "@/lib/attendance/monthly-summary-export";
import { getMonthlyAttendanceSummary, resolveSummaryMonth } from "@/lib/attendance/monthly-summary";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiResponse(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { error: "forbidden", message: error instanceof Error ? error.message : "Forbidden." },
      { status: 403 },
    );
  }

  const apiError = toApiError(error, fallback);
  return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "read");

    const url = new URL(request.url);
    const month = resolveSummaryMonth(url.searchParams.get("month") ?? undefined);
    const data = await getMonthlyAttendanceSummary({ month });
    const workbook = await generateMonthlyAttendanceSummaryWorkbook(data);
    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="phoenix-attendance-monthly-summary-${data.month}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    return apiResponse(error, "Monthly attendance summary export failed.");
  }
}
