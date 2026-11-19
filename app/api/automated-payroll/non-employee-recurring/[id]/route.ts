import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import {
  deleteRecurringNonEmployee,
  updateRecurringNonEmployee,
} from "@/lib/automated-payroll/non-employee-recurring";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import type { RecurringNonEmployeeInput } from "@/lib/automated-payroll/types";
import { isNonEmployeePart } from "@/lib/automated-payroll/types";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One standing-roster entry as the panel sends it (REC-060): names and bank as text (bank fields may be
 * null), the salary as a number (a typed string is still coerced below), `part`, the `active` switch
 * and an optional note. The part's value is judged below with the route's own sentence; any extra key is
 * dropped.
 */
const RecurringNonEmployeeBodySchema = z.object({
  fullNameAr: z.string().optional(),
  fullNameEn: z.string().optional(),
  totalSalary: z.union([z.number(), z.string()]).nullable().optional(),
  bankName: z.string().nullable().optional(),
  bankAccount: z.string().nullable().optional(),
  part: z.string().optional(),
  active: z.boolean().optional(),
  note: z.string().nullable().optional(),
});

/** PUT: update one standing-roster entry (including activating/deactivating it). */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    // REC-080: the service's own gate, asked before the body is judged.
    assertAutomatedPayrollHrActor(access);
    const parsed = await parseJsonBody(request, RecurringNonEmployeeBodySchema, { fallback: {} });
    if (!parsed.ok) return jsonError(new Error(`Validation: ${parsed.message}`));
    const body = parsed.data;
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
      part: isNonEmployeePart(body.part) ? body.part : undefined,
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
