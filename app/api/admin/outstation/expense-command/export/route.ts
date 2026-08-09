import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  EXPENSE_SOURCE_LABELS,
  formatShortDate,
  parseExpenseFiltersFromSearchParams,
} from "@/components/outstation/expense-shared/formatters";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { getOutstationExpenseCommandData } from "@/lib/outstation/expense-command";
import { buildPhoenixTableWorkbook, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Row keys align with the `outstation_expenses` workbook template (which sums
// total/travelCost/meetingAmount/allowance/other/km and wraps address/hrNotes).
const COLUMNS: ExportColumn[] = [
  { key: "date", label: "Date" },
  { key: "specialist", label: "Employee" },
  { key: "region", label: "Region" },
  { key: "line", label: "Line" },
  { key: "address", label: "Destination" },
  { key: "tripType", label: "Type" },
  { key: "transportationType", label: "Transport" },
  { key: "source", label: "Source" },
  { key: "status", label: "Status" },
  { key: "travelCost", label: "Travel Cost", numeric: true },
  { key: "meetingAmount", label: "Meeting Amount", numeric: true },
  { key: "allowance", label: "Allowance", numeric: true },
  { key: "other", label: "Other", numeric: true },
  { key: "km", label: "KM", numeric: true },
  { key: "total", label: "Total", numeric: true },
  { key: "hrNotes", label: "HR Notes" },
];

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "read");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:admin:outstation" });
    const filters = parseExpenseFiltersFromSearchParams(new URL(request.url).searchParams);
    const data = await getOutstationExpenseCommandData(access, filters);

    const rows: ExportRow[] = data.rows.map((row) => ({
      date: formatShortDate(row.date),
      specialist: row.specialist || "—",
      region: row.region ?? "—",
      line: row.line ?? "—",
      address: row.to || row.location || "—",
      tripType: row.tripType || "—",
      transportationType: row.transportationType || "—",
      source: EXPENSE_SOURCE_LABELS[row.source],
      status: row.status || "—",
      travelCost: row.travelCost ?? 0,
      meetingAmount: row.meetingAmount ?? 0,
      allowance: row.allowance ?? 0,
      other: row.other ?? 0,
      km: row.km ?? 0,
      total: row.total ?? 0,
      hrNotes: row.hrNotes ?? "",
    }));

    const buffer = await buildPhoenixTableWorkbook({
      title: "Outstation Expense Command Center",
      subtitle: `${data.windowLabel} · ${rows.length.toLocaleString()} rows · exported ${new Date().toLocaleString("en-GB")}`,
      sheetName: "Outstation Expenses",
      columns: COLUMNS,
      rows,
      template: "outstation_expenses",
    });

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "outstation_expense_access",
      entityId: null,
      summary: `Exported outstation expense command report (${rows.length} rows · ${data.windowLabel})`,
    });

    const filename = `outstation-expense-command-${new Date().toISOString().slice(0, 10)}.xlsx`;
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
    const message = clientSafeErrorMessage(error, "Failed to export outstation expenses.");
    return NextResponse.json({ error: "outstation_expense_export_failed", message }, { status: 500 });
  }
}
