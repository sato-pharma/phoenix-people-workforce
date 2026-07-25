import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { deleteNonEmployeePayrollEntry, updateNonEmployeePayrollEntry } from "@/lib/automated-payroll/non-employees";
import type { NonEmployeePayrollInput } from "@/lib/automated-payroll/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT: update one Non-Employees Payroll entry. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ runId: string; id: string }> },
) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId, id } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Partial<NonEmployeePayrollInput>;
    const input: NonEmployeePayrollInput = {
      fullNameAr: String(body.fullNameAr ?? ""),
      fullNameEn: String(body.fullNameEn ?? ""),
      totalSalary: Number(body.totalSalary ?? 0),
      bankName: body.bankName ?? null,
      bankAccount: body.bankAccount ?? null,
    };
    const row = await updateNonEmployeePayrollEntry(access, runId, id, input);
    return NextResponse.json({ success: true, row });
  } catch (error) {
    return jsonError(error, "Failed to update the entry.");
  }
}

/** DELETE: remove one Non-Employees Payroll entry. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ runId: string; id: string }> },
) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId, id } = await params;
    const access = await resolveAccessContext(request);
    await deleteNonEmployeePayrollEntry(access, runId, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return jsonError(error, "Failed to delete the entry.");
  }
}
