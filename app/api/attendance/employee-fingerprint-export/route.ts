import { NextResponse } from "next/server";

import { generateFingerprintReportWorkbook } from "@/lib/attendance/fingerprint-report-export";
import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function filename(hrId: string) {
  return `phoenix-attendance-${hrId}-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);

    if (!(await canAccess(access, "attendance", "read"))) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }

    const hrId = access.hrId;
    if (!hrId) {
      return NextResponse.json({ error: "unauthorized", message: "No employee identity." }, { status: 401 });
    }

    const url = new URL(request.url);
    const dateFrom = url.searchParams.get("dateFrom") ?? undefined;
    const dateTo = url.searchParams.get("dateTo") ?? undefined;

    const data = await getFingerprintAttendanceReport({ dateFrom, dateTo, exactEmployeeHrId: hrId });
    const workbook = await generateFingerprintReportWorkbook(data);
    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="${filename(hrId)}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    const apiError = toApiError(error, "Attendance export failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
