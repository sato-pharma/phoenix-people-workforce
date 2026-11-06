import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildExpenseApprovalExportRows,
  expenseApprovalExportEmployeeLabel,
  expenseApprovalExportFilename,
  expenseApprovalExportSubtitle,
} from "@/lib/outstation/expense-approval-export";
import { parseExpenseTripTriageFilter } from "@/lib/outstation/expense-approval-filters";
import { listUnifiedOutstationExpenses } from "@/lib/outstation/expenses";
import { buildPhoenixTableWorkbook, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One row per trip. "Claimed Total" and "Approved Amount" are the before/after pair the Deduction
// field on the decision panel is built on — never re-derived a second way here.
// The upload importer refuses this file by some of these labels (EXPENSE_APPROVALS_DOWNLOAD_COLUMNS in
// src/lib/outstation/expense-import.ts) and by its worksheet name ("Expense Approvals" below, pinned as
// EXPENSE_APPROVALS_DOWNLOAD_SHEET_NAME); renaming either fails tests/outstation-sheet-refuses-approvals-export.test.ts.
const COLUMNS: ExportColumn[] = [
  { key: "specialist", label: "Employee" },
  { key: "hrId", label: "HR ID" },
  { key: "tripId", label: "Trip ID" },
  { key: "tripStartDate", label: "Start Date" },
  { key: "tripEndDate", label: "End Date" },
  { key: "expenseType", label: "Expense Type" },
  { key: "tripType", label: "Trip Type" },
  { key: "transportationType", label: "Transport" },
  { key: "from", label: "From" },
  { key: "destination", label: "To" },
  { key: "km", label: "Distance (KM)", numeric: true },
  { key: "distanceFlag", label: "Distance Flag" },
  { key: "workloadAm", label: "Declared AM", numeric: true },
  { key: "workloadPm", label: "Declared PM", numeric: true },
  { key: "workloadPharmacies", label: "Declared Pharmacies", numeric: true },
  { key: "travelCost", label: "Travel Cost", numeric: true },
  { key: "meetingAmount", label: "Meeting Amount", numeric: true },
  { key: "allowance", label: "Allowance", numeric: true },
  { key: "other", label: "Other", numeric: true },
  { key: "claimedTotal", label: "Claimed (Before Deduction)", numeric: true },
  { key: "deduction", label: "Deduction", numeric: true },
  { key: "approvedAmount", label: "Approved (After Deduction)", numeric: true },
  { key: "status", label: "Status" },
  { key: "hrComment", label: "HR Comment" },
  { key: "approvedBy", label: "Approved By" },
  { key: "approvedAt", label: "Approved At" },
  { key: "reportId", label: "Report ID" },
  { key: "sourceFileName", label: "Source File" },
];

function formatTimestamp(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  // Cairo local, never raw UTC (house rule) — this stamps the Approved At column a reviewer reads.
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("en-GB", { timeZone: "Africa/Cairo" });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // An expired session must not be reported as a missing permission (see
    // api-session-response.ts). A guest is already denied everything, so this only changes how the
    // denial reads, never who gets through.
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;

    assertSystemAdministratorWorkspaceAccess(access, "outstation expense approvals export");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:admin:outstation-expense-approvals",
    });

    const url = new URL(request.url);
    const filters = {
      employee: url.searchParams.get("employee") ?? "",
      month: url.searchParams.get("month") ?? "",
      // The rail's "Needs a look" / "Clean", so the file holds exactly the trips on screen.
      triage: parseExpenseTripTriageFilter(url.searchParams.get("triage")),
    };
    const search = url.searchParams.get("search") ?? "";

    // The same legacy-table read the Expense Approvals screen makes, so the file and the screen it
    // was downloaded from cannot disagree while the `expense_claims` mirror waits for its rebuild.
    const records = await listUnifiedOutstationExpenses(undefined, undefined, undefined, access, {
      readLegacyTables: true,
    });
    const rows = buildExpenseApprovalExportRows(records, filters, search);
    const employeeLabel = expenseApprovalExportEmployeeLabel(records, filters.employee);

    const exportRows: ExportRow[] = rows.map((row) => ({
      ...row,
      approvedAt: formatTimestamp(row.approvedAt),
    }));

    const buffer = await buildPhoenixTableWorkbook({
      columns: COLUMNS,
      rows: exportRows,
      sheetName: "Expense Approvals",
      subtitle: expenseApprovalExportSubtitle(filters, employeeLabel, rows.length),
      title: "Phoenix Workforce — Expense Approvals",
    });

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "outstation_expense_access",
      entityId: null,
      summary: `Exported outstation expense approvals (${rows.length} rows${
        filters.month || employeeLabel ? ` · ${[filters.month, employeeLabel].filter(Boolean).join(" · ")}` : ""
      })`,
    });

    const filename = expenseApprovalExportFilename(filters, employeeLabel);
    return new NextResponse(buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden") },
        { status: 403 },
      );
    }
    const message = clientSafeErrorMessage(error, "Failed to export expense approvals.");
    return NextResponse.json({ error: "outstation_expense_approvals_export_failed", message }, { status: 500 });
  }
}
