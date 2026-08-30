import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import {
  addRecurringNonEmployee,
  listRecurringNonEmployees,
} from "@/lib/automated-payroll/non-employee-recurring";
import type { RecurringNonEmployeeInput } from "@/lib/automated-payroll/types";
import { isNonEmployeePart } from "@/lib/automated-payroll/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: the standing Non-Employees Payroll roster — every entry, active first. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const rows = await listRecurringNonEmployees(access);
    return NextResponse.json({ success: true, rows });
  } catch (error) {
    return jsonError(error, "Failed to load the standing roster.");
  }
}

/** POST: add one person to the standing roster (defaults to the first installment). */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
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
      part: body.part,
      active: body.active,
      note: body.note ?? null,
    };
    const row = await addRecurringNonEmployee(access, input);
    return NextResponse.json({ success: true, row });
  } catch (error) {
    return jsonError(error, "Failed to add the entry to the standing roster.");
  }
}
