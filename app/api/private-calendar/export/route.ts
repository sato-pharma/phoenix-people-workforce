import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildPrivateCalendarPdf, buildPrivateCalendarWorkbook } from "@/lib/private-calendar/export";
import { getPrivateCalendarWorkspace } from "@/lib/private-calendar/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const { searchParams } = new URL(request.url);
    const format = searchParams.get("format") ?? "xlsx";
    // Cairo's month, never UTC's — see the calendar API route.
    const now = currentCairoDateParts();
    const year = Number(searchParams.get("year") ?? now.year);
    const month = Number(searchParams.get("month") ?? now.month);
    const employeeHrId = searchParams.get("employeeHrId") ?? undefined;
    const viewMode = searchParams.get("view") ?? undefined;
    const actualOnly = searchParams.get("actualOnly") === "1";

    if (!["xlsx", "pdf"].includes(format)) {
      return NextResponse.json({ error: "invalid_format", message: "format must be xlsx or pdf.", success: false }, { status: 400 });
    }
    if (!Number.isInteger(year) || year < 2020 || year > 2099) {
      return NextResponse.json({ error: "invalid_year", message: "year is invalid.", success: false }, { status: 400 });
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return NextResponse.json({ error: "invalid_month", message: "month must be 1–12.", success: false }, { status: 400 });
    }

    const workspace = await getPrivateCalendarWorkspace({ access, actualOnly, employeeHrId, month, viewMode, year });
    const generatedAt = new Date();
    const employeeName = workspace.selectedEmployee.fullName.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_");
    const periodLabel = `${year}-${String(month).padStart(2, "0")}`;

    if (format === "pdf") {
      const buffer = await buildPrivateCalendarPdf(workspace, generatedAt);
      return new Response(buffer as unknown as BodyInit, {
        headers: {
          ...DOWNLOAD_NO_STORE_HEADERS,
          "Content-Disposition": `attachment; filename="phoenix_private_calendar_${employeeName}_${periodLabel}.pdf"`,
          "Content-Type": "application/pdf",
        },
      });
    }

    const buffer = await buildPrivateCalendarWorkbook(workspace, generatedAt);
    return new Response(buffer as unknown as BodyInit, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="phoenix_private_calendar_${employeeName}_${periodLabel}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Export failed.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "export_failed", message, success: false },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
