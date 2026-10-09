import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { chargeDeductionToLeaveBalance, previewLeaveBalanceCharge, returnDeductionToSalary } from "@/lib/deductions/leave-balance.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What "Deduct from leave balance" would do for one deduction — read only, for the confirmation dialog. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "approve");

    const candidateId = new URL(request.url).searchParams.get("candidateId");
    if (!candidateId?.trim()) throw new Error("Validation: candidateId is required.");

    const preview = await previewLeaveBalanceCharge({ actor: access, candidateId });
    return NextResponse.json({ success: true, preview });
  } catch (error) {
    return jsonError(error, "Failed to read the leave balance.");
  }
}

type LeaveBalanceBody = {
  action?: unknown;
  candidateId?: unknown;
  comment?: unknown;
  reason?: unknown;
};

/**
 * `charge` takes a CRM / half-day deduction from the employee's annual leave (the comment is required
 * and is what the employee reads); `return` puts it back on salary. Super Admin only — the service
 * asserts it again, so this route is never the only gate.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "approve");

    const body = (await request.json()) as LeaveBalanceBody;
    if (typeof body.candidateId !== "string" || !body.candidateId.trim()) {
      throw new Error("Validation: candidateId is required.");
    }

    if (body.action === "charge") {
      const result = await chargeDeductionToLeaveBalance({
        actor: access,
        candidateId: body.candidateId,
        comment: typeof body.comment === "string" ? body.comment : "",
      });
      return NextResponse.json({ success: true, ...result });
    }
    if (body.action === "return") {
      const result = await returnDeductionToSalary({
        actor: access,
        candidateId: body.candidateId,
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
      return NextResponse.json({ success: true, ...result });
    }
    throw new Error('Validation: action must be "charge" or "return".');
  } catch (error) {
    return jsonError(error, "Failed to change the leave balance charge.");
  }
}
