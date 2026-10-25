import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertCompanyVacationReportReadAccess, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { generateCompanyVacationReportWorkbook } from "@/lib/vacation/company-vacation-report-export";
import {
  describeCompanyVacationReportFilters,
  filterCompanyVacationReportRows,
  parseCompanyVacationReportFilters,
} from "@/lib/vacation/company-vacation-report-filters";
import { getCompanyVacationReport } from "@/lib/vacation/company-vacation-report";
import { resolveCompanyVacationReportRange } from "@/lib/vacation/company-vacation-report-range";
import { clientSafeErrorMessage, toApiError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Row 4 of the sheet — the blank spacer the workbook leaves between its range banner (row 3)
 * and the header (row 6). */
const FILTER_NOTE_ROW = 4;

/**
 * Writes the filter stamp onto the sheet itself. A downloaded workbook is forwarded without the
 * screen it came from, so a filtered one that looks exactly like a full-range one is how a slice
 * of the year gets read as the whole year by whoever opens it next.
 */
function stampFilterNote(workbook: ReturnType<typeof generateCompanyVacationReportWorkbook>, note: string) {
  const sheet = workbook.getWorksheet("Company Vacation Report");
  if (!sheet) return;
  const cell = sheet.getCell(FILTER_NOTE_ROW, 1);
  // If the sheet layout ever moves real content up into the spacer, skip rather than overwrite
  // a header or a leave row.
  if (cell.value != null) return;
  if (sheet.columnCount > 1) sheet.mergeCells(FILTER_NOTE_ROW, 1, FILTER_NOTE_ROW, sheet.columnCount);
  cell.value = note;
  cell.font = { bold: true, color: { argb: "FF9A3412" }, italic: true };
  cell.alignment = { horizontal: "center", wrapText: true };
}

function apiResponse(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({
      error: "forbidden",
      message: clientSafeErrorMessage(error, "Forbidden."),
      success: false,
    }, { status: 403 });
  }

  const apiError = toApiError(error, fallback);
  return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // The READ gate, not the workspace gate — this route only ever hands back a workbook of what
    // the caller can already see on screen. Writing from this report (turning a CRM Signal into a
    // real vacation request) lives in ../approve and still asserts system-administrator access.
    assertCompanyVacationReportReadAccess(access, "the company vacation report");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:admin:company-vacation-report" });

    const url = new URL(request.url);
    // Same resolver the page uses, so the workbook's range is the screen's range and a malformed
    // or hand-edited link falls back to the default report rather than reaching the database with
    // a date the picker could never have produced.
    const { endDate, startDate } = resolveCompanyVacationReportRange(
      { endDate: url.searchParams.get("endDate"), startDate: url.searchParams.get("startDate") },
      new Date().toISOString().slice(0, 10),
    );

    // The link carries the reader's on-screen filters — their slice, never their permissions
    // (the workspace gate above already decided that). Narrowing here with the same
    // filterCompanyVacationReportRows the table uses is what keeps the workbook equal to the
    // "N rows · M employees · D total days" counter printed next to the Export button.
    const filters = parseCompanyVacationReportFilters(url.searchParams);
    const rangeRows = await getCompanyVacationReport({ endDate, startDate });
    const rows = filterCompanyVacationReportRows(rangeRows, filters);
    const filterNote = describeCompanyVacationReportFilters(filters);

    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: `${startDate}:${endDate}`,
      entityType: "vacation_report_export",
      newValues: { endDate, filters, rangeRowCount: rangeRows.length, rowCount: rows.length, startDate },
      summary: filterNote ? `Company vacation report exported. ${filterNote}` : "Company vacation report exported.",
    });

    const workbook = generateCompanyVacationReportWorkbook({ endDate, rows, startDate });
    if (filterNote) stampFilterNote(workbook, filterNote);
    const buffer = await workbook.xlsx.writeBuffer();

    // A filtered file is named as one: two downloads of the same range that hold different row
    // counts must not land in the reader's Downloads folder under the same name.
    const fileName = `company-vacation-report-${startDate}-to-${endDate}${filterNote ? "-filtered" : ""}.xlsx`;

    return new NextResponse(buffer, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return apiResponse(error, "Company vacation report export failed.");
  }
}
