import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertCompanyActivityReportReadAccess, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { generateCompanyActivityReportWorkbook } from "@/lib/company-activity-report/export";
import { describeCompanyActivityFilters, filterCompanyActivityEmployees, parseCompanyActivityFilters } from "@/lib/company-activity-report/filters";
import { resolveCompanyActivityReportRange } from "@/lib/company-activity-report/range";
import { getCompanyActivityReport } from "@/lib/company-activity-report/service";
import { clientSafeErrorMessage, toApiError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Row 4 of each data sheet — the blank spacer export.ts leaves right after its title band (rows
 * 1-3) on every sheet, whatever comes after it (Daily Detail's header sits at a fixed row 6;
 * Executive Summary's KPI block pushes its own table header further down). Same row on both data
 * sheets, so one stamp routine covers both regardless of what each sheet does after row 4. */
const FILTER_NOTE_ROW = 4;
const DATA_SHEET_NAMES = ["Executive Summary", "Daily Detail"];

/**
 * Writes the filter stamp onto both data sheets. A downloaded workbook is forwarded without the
 * screen it came from, so a filtered one that looks exactly like a full-range one is how a slice
 * of the company gets read as the whole company by whoever opens it next.
 */
function stampFilterNote(workbook: ReturnType<typeof generateCompanyActivityReportWorkbook>, note: string) {
  for (const sheetName of DATA_SHEET_NAMES) {
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) continue;
    const cell = sheet.getCell(FILTER_NOTE_ROW, 1);
    // If the sheet layout ever moves real content up into the spacer, skip rather than overwrite
    // a header or a data row.
    if (cell.value != null) continue;
    if (sheet.columnCount > 1) sheet.mergeCells(FILTER_NOTE_ROW, 1, FILTER_NOTE_ROW, sheet.columnCount);
    cell.value = note;
    cell.font = { bold: true, color: { argb: "FF9A3412" }, italic: true };
    cell.alignment = { horizontal: "center", wrapText: true };
  }
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
    assertCompanyActivityReportReadAccess(access, "the company activity report");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:admin:company-activity-report" });

    const url = new URL(request.url);
    // Same resolver the page uses, so the workbook's range is the screen's range and a malformed
    // or hand-edited link falls back to the default report rather than reaching the database with
    // a date the picker could never have produced.
    const { endDate, startDate } = resolveCompanyActivityReportRange(
      { endDate: url.searchParams.get("endDate"), startDate: url.searchParams.get("startDate") },
      new Date().toISOString().slice(0, 10),
    );

    // The link carries the reader's on-screen filters — their slice, never their permissions (the
    // role gate above already decided that). Narrowing the roster here with the same
    // filterCompanyActivityEmployees the page uses is what keeps the workbook equal to what the
    // screen shows, never a superset or a subset of it.
    const filters = parseCompanyActivityFilters(url.searchParams);
    const roster = await getEmployeeDirectoryRows({ includeInactive: true });
    const employees = filterCompanyActivityEmployees(roster, filters);
    const report = await getCompanyActivityReport({ employees, endDate, startDate });
    const filterNote = describeCompanyActivityFilters(filters);

    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: `${startDate}:${endDate}`,
      entityType: "company_activity_report_export",
      newValues: {
        dayRowCount: report.days.length,
        employeeCount: employees.length,
        endDate,
        filters,
        startDate,
        unmappedCrmVisitCount: report.unmappedCrmVisitCount,
      },
      summary: filterNote ? `Company activity report exported. ${filterNote}` : "Company activity report exported.",
    });

    const employeeNameByHrId = new Map(report.summaries.map((summary) => [summary.employeeHrId, summary.employeeName]));
    const workbook = generateCompanyActivityReportWorkbook({ employeeNameByHrId, report });
    if (filterNote) stampFilterNote(workbook, filterNote);
    const buffer = await workbook.xlsx.writeBuffer();

    // A filtered file is named as one: two downloads of the same range that hold different
    // employee counts must not land in the reader's Downloads folder under the same name.
    const fileName = `company-activity-report-${startDate}-to-${endDate}${filterNote ? "-filtered" : ""}.xlsx`;

    return new NextResponse(buffer, {
      headers: {
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
    return apiResponse(error, "Company activity report export failed.");
  }
}
