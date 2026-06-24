import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  listMonthlyDeductionSummaries,
  listMonthlyDeductionSummaryLines,
} from "@/lib/deductions-governance/service";
import { payrollColumnLabel } from "@/lib/deductions-governance/calculations";
import type {
  DeductionMonthlySummary,
  DeductionMonthlySummaryLine,
} from "@/lib/deductions-governance/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string, defaultStatus = 500) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, message: (error as Error).message }, { status: 403 });
  }
  const message = error instanceof Error ? error.message : fallback;
  const lower = message.toLowerCase();
  if (lower.includes("not authenticated")) return NextResponse.json({ success: false, message }, { status: 401 });
  if (lower.includes("forbidden")) return NextResponse.json({ success: false, message }, { status: 403 });
  if (lower.includes("not found")) return NextResponse.json({ success: false, message }, { status: 404 });
  if (lower.includes("required") || lower.includes("invalid")) {
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
  return NextResponse.json({ success: false, message }, { status: defaultStatus });
}

function money(value: number) {
  return Math.round(value * 100) / 100;
}

function fileName(summary: DeductionMonthlySummary) {
  return `phoenix-deductions-governance-${summary.monthKey}.xlsx`;
}

function buildWorkbook(summary: DeductionMonthlySummary, lines: DeductionMonthlySummaryLine[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = "Deductions Governance finalized payroll handoff";
  workbook.title = `Deductions Governance ${summary.monthKey}`;

  const totalsSheet = workbook.addWorksheet("Payroll Totals");
  totalsSheet.columns = [
    { header: "HR ID", key: "employeeCode", width: 16 },
    { header: "Employee", key: "employeeName", width: 28 },
    { header: "Month", key: "monthKey", width: 12 },
    { header: "CRM", key: "crm", width: 14 },
    { header: "Finger Print", key: "fingerPrint", width: 16 },
    { header: "Unpaid Vacations", key: "unpaidVacations", width: 18 },
    { header: "Total", key: "total", width: 14 },
  ];

  const byEmployee = new Map<string, {
    crm: number;
    employeeCode: string;
    employeeName: string | null;
    fingerPrint: number;
    unpaidVacations: number;
  }>();
  for (const line of lines) {
    const bucket = byEmployee.get(line.employeeCode) ?? {
      crm: 0,
      employeeCode: line.employeeCode,
      employeeName: line.employeeName,
      fingerPrint: 0,
      unpaidVacations: 0,
    };
    if (line.payrollColumn === "crm") bucket.crm += line.appliedAmount;
    if (line.payrollColumn === "finger_print") bucket.fingerPrint += line.appliedAmount;
    if (line.payrollColumn === "unpaid_vacations") bucket.unpaidVacations += line.appliedAmount;
    byEmployee.set(line.employeeCode, bucket);
  }

  for (const row of [...byEmployee.values()].sort((left, right) => left.employeeCode.localeCompare(right.employeeCode))) {
    totalsSheet.addRow({
      crm: money(row.crm),
      employeeCode: row.employeeCode,
      employeeName: row.employeeName ?? "",
      fingerPrint: money(row.fingerPrint),
      monthKey: summary.monthKey,
      total: money(row.crm + row.fingerPrint + row.unpaidVacations),
      unpaidVacations: money(row.unpaidVacations),
    });
  }

  const detailSheet = workbook.addWorksheet("Decision Lines");
  detailSheet.columns = [
    { header: "HR ID", key: "employeeCode", width: 16 },
    { header: "Employee", key: "employeeName", width: 28 },
    { header: "Month", key: "monthKey", width: 12 },
    { header: "Source", key: "sourceModule", width: 20 },
    { header: "Type", key: "deductionType", width: 22 },
    { header: "Payroll Column", key: "payrollColumn", width: 18 },
    { header: "Unit", key: "unit", width: 10 },
    { header: "Original Value", key: "originalValue", width: 16 },
    { header: "HR Applied Value", key: "appliedValue", width: 18 },
    { header: "Applied Amount", key: "appliedAmount", width: 16 },
    { header: "Dates", key: "dates", width: 34 },
    { header: "Reason", key: "reason", width: 36 },
    { header: "HR Note", key: "hrNote", width: 36 },
  ];
  for (const line of lines) {
    detailSheet.addRow({
      appliedAmount: money(line.appliedAmount),
      appliedValue: line.appliedDeductionValue,
      dates: line.dates.join(", "),
      deductionType: line.deductionType,
      employeeCode: line.employeeCode,
      employeeName: line.employeeName ?? "",
      hrNote: line.hrNote ?? "",
      monthKey: line.monthKey,
      originalValue: line.originalDeductionValue,
      payrollColumn: payrollColumnLabel(line.payrollColumn),
      reason: line.reason ?? "",
      sourceModule: line.sourceModule,
      unit: line.deductionUnit,
    });
  }

  for (const sheet of [totalsSheet, detailSheet]) {
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { vertical: "middle" };
    sheet.autoFilter = {
      from: { column: 1, row: 1 },
      to: { column: sheet.columnCount, row: Math.max(1, sheet.rowCount) },
    };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }

  return workbook;
}

async function resolveSummary(input: {
  access: Awaited<ReturnType<typeof resolveAccessContext>>;
  monthKey?: string;
  summaryId?: string;
}) {
  const summaries = await listMonthlyDeductionSummaries({
    access: input.access,
    monthKey: input.monthKey,
    limit: 100,
  });
  const summary = input.summaryId
    ? summaries.find((item) => item.id === input.summaryId)
    : summaries[0];
  if (!summary) throw new Error("No finalized deduction summary found for export.");
  return summary;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:admin:deductions" });
    const body = await request.json().catch(() => ({}));
    const summary = await resolveSummary({
      access,
      monthKey: typeof body.monthKey === "string" ? body.monthKey : undefined,
      summaryId: typeof body.summaryId === "string" ? body.summaryId : undefined,
    });
    const lines = await listMonthlyDeductionSummaryLines({ access, summaryId: summary.id });
    const workbook = buildWorkbook(summary, lines);
    const buffer = await workbook.xlsx.writeBuffer();
    const name = fileName(summary);

    const { data: exportRow, error: exportError } = await getSupabaseAdmin()
      .from("deduction_exports")
      .insert({
        decision_count: lines.length,
        file_name: name,
        filters_snapshot: {
          monthKey: summary.monthKey,
          summaryId: summary.id,
          source: "monthly_finalized_summary",
        },
        generated_by: access.loginId ?? access.hrId ?? "system",
        month_key: summary.monthKey,
        notes: "Generated from finalized Deductions Governance monthly summary.",
      })
      .select("id")
      .single();
    if (exportError) throw exportError;

    await writeAuditLog({
      actorLoginId: access.loginId ?? access.hrId ?? "system",
      entityId: String(exportRow?.id ?? summary.id),
      entityType: "deduction_export",
      newValues: {
        fileName: name,
        lineCount: lines.length,
        monthKey: summary.monthKey,
        summaryId: summary.id,
      },
      summary: `Deductions export generated for ${summary.monthKey}.`,
    });

    return new NextResponse(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="${name}"`,
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
    return jsonError(error, "Deductions export failed.");
  }
}
