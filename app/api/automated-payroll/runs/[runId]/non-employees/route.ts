import { NextResponse } from "next/server";
import { z } from "zod";

import { addNonEmployeePayrollEntry, listNonEmployeePayroll } from "@/lib/automated-payroll/non-employees";
import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
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
 * The part's value is judged below with the route's own sentence; any extra key the panel carries
 * (its new-row `tempId`) is dropped.
 */
const NonEmployeeEntryBodySchema = z.object({
  fullNameAr: z.string().optional(),
  fullNameEn: z.string().optional(),
  totalSalary: z.union([z.number(), z.string()]).nullable().optional(),
  bankName: z.string().nullable().optional(),
  bankAccount: z.string().nullable().optional(),
  part: z.string().optional(),
});

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
      part: isNonEmployeePart(body.part) ? body.part : undefined,
    };
    const row = await addNonEmployeePayrollEntry(access, runId, input);
    return NextResponse.json({ success: true, row });
  } catch (error) {
    return jsonError(error, "Failed to add the entry.");
  }
}
