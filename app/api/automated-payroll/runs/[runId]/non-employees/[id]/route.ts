import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { deleteNonEmployeePayrollEntry, updateNonEmployeePayrollEntry } from "@/lib/automated-payroll/non-employees";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import type { NonEmployeePayrollInput } from "@/lib/automated-payroll/types";
import { isNonEmployeePart } from "@/lib/automated-payroll/types";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One Non-Employees Payroll entry as the panel sends it (REC-060): names and bank as text (bank fields
 * may be null), the salary as a number (a typed string is still coerced below), and the panel's `part`.
 * The part's value is judged below with the route's own sentence; any extra key is dropped.
 */
const NonEmployeeEntryBodySchema = z.object({
  fullNameAr: z.string().optional(),
  fullNameEn: z.string().optional(),
  totalSalary: z.union([z.number(), z.string()]).nullable().optional(),
  bankName: z.string().nullable().optional(),
  bankAccount: z.string().nullable().optional(),
  part: z.string().optional(),
});

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
    assertSignedIn(access);
    // REC-080: the service's own gate, asked before the body is judged.
    assertAutomatedPayrollHrActor(access);
    const parsed = await parseJsonBody(request, NonEmployeeEntryBodySchema, { fallback: {} });
    if (!parsed.ok) return jsonError(new Error(`Validation: ${parsed.message}`));
    const body = parsed.data;
    if (body.part !== undefined && !isNonEmployeePart(body.part)) {
      return jsonError(new Error("Validation: part must be either first or second."));
    }
    const input: NonEmployeePayrollInput = {
      fullNameAr: String(body.fullNameAr ?? ""),
      fullNameEn: String(body.fullNameEn ?? ""),
      totalSalary: Number(body.totalSalary ?? 0),
      bankName: body.bankName ?? null,
      bankAccount: body.bankAccount ?? null,
      // Omitted keeps the entry where it is — an edit form that doesn't know
      // about parts must never silently move money to the other installment.
      part: isNonEmployeePart(body.part) ? body.part : undefined,
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
