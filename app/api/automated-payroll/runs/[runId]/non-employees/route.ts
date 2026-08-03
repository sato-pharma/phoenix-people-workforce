import { NextResponse } from "next/server";

import { addNonEmployeePayrollEntry, listNonEmployeePayroll } from "@/lib/automated-payroll/non-employees";
import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import type { NonEmployeePayrollInput } from "@/lib/automated-payroll/types";
import { isNonEmployeePart } from "@/lib/automated-payroll/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET: Non-Employees Payroll for this run — one installment's entries with
 * `?part=first|second`, or every entry when the parameter is omitted (which is
 * what the export paths want, and what this route did before parts existed).
 */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const requested = new URL(request.url).searchParams.get("part");
    if (requested !== null && !isNonEmployeePart(requested)) {
      return jsonError(new Error("Validation: part must be either first or second."));
    }
    const rows = await listNonEmployeePayroll(access, runId, requested ?? undefined);
    return NextResponse.json({ success: true, rows });
  } catch (error) {
    return jsonError(error, "Failed to load Non-Employees Payroll.");
  }
}

/** POST: add one Non-Employees Payroll entry (defaults to the first installment). */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Partial<NonEmployeePayrollInput>;
    if (body.part !== undefined && !isNonEmployeePart(body.part)) {
      return jsonError(new Error("Validation: part must be either first or second."));
    }
    const input: NonEmployeePayrollInput = {
      fullNameAr: String(body.fullNameAr ?? ""),
      fullNameEn: String(body.fullNameEn ?? ""),
      totalSalary: Number(body.totalSalary ?? 0),
      bankName: body.bankName ?? null,
      bankAccount: body.bankAccount ?? null,
      part: body.part,
    };
    const row = await addNonEmployeePayrollEntry(access, runId, input);
    return NextResponse.json({ success: true, row });
  } catch (error) {
    return jsonError(error, "Failed to add the entry.");
  }
}
