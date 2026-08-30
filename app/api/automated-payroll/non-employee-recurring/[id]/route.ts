import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import {
  deleteRecurringNonEmployee,
  updateRecurringNonEmployee,
} from "@/lib/automated-payroll/non-employee-recurring";
import type { RecurringNonEmployeeInput } from "@/lib/automated-payroll/types";
import { isNonEmployeePart } from "@/lib/automated-payroll/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT: update one standing-roster entry (including activating/deactivating it). */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Partial<RecurringNonEmployeeInput>;
    if (body.part !== undefined && !isNonEmployeePart(body.part)) {
      return jsonError(new Error("Validation: part must be either first or second."));
    }
    const input: RecurringNonEmployeeInput = {
      fullNameAr: String(body.fullNameAr ?? ""),
      fullNameEn: String(body.fullNameEn ?? ""),
      totalSalary: Number(body.totalSalary ?? 0),
      bankName: body.bankName ?? null,
      bankAccount: body.bankAccount ?? null,
      // Both omitted-means-unchanged, same contract as the per-run edit route: a
      // form that doesn't send them must never silently move someone to the other
      // installment or switch them off.
      part: body.part,
      active: body.active,
      note: body.note ?? null,
    };
    const row = await updateRecurringNonEmployee(access, id, input);
    return NextResponse.json({ success: true, row });
  } catch (error) {
    return jsonError(error, "Failed to update the standing roster entry.");
  }
}

/** DELETE: remove one standing-roster entry. Rows already copied into runs survive. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    await deleteRecurringNonEmployee(access, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return jsonError(error, "Failed to remove the standing roster entry.");
  }
}
