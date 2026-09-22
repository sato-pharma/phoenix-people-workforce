import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertDeductionsPublishActor } from "@/lib/deductions/permissions.ts";
import { pushDeduction, pushForEmployee, withdrawDeduction } from "@/lib/deductions/push.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PushBody = {
  monthKey?: unknown;
  candidateId?: unknown;
  employeeHrIdCompact?: unknown;
  candidateIds?: unknown;
};

type WithdrawBody = {
  lineId?: unknown;
};

/**
 * Push a deduction — one candidate, or some/all of one employee's candidates.
 *
 * Super Admin only: `assertPermission(...,"approve")` is the coarse gate and
 * `assertDeductionsPublishActor` the fine one; the domain functions assert it
 * again, so a direct RPC cannot bypass it. Body shapes:
 *   { monthKey, candidateId }                               → push that one line
 *   { monthKey, employeeHrIdCompact, candidateIds? }        → push those / all
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "approve");
    assertDeductionsPublishActor(access);

    const body = (await request.json()) as PushBody;
    if (typeof body.monthKey !== "string" || !body.monthKey.trim()) {
      throw new Error("Validation: monthKey is required (YYYY-MM).");
    }

    if (typeof body.candidateId === "string" && body.candidateId.trim()) {
      const line = await pushDeduction({
        monthKey: body.monthKey,
        candidateId: body.candidateId,
        actor: access,
      });
      return NextResponse.json({ success: true, line });
    }

    if (typeof body.employeeHrIdCompact === "string" && body.employeeHrIdCompact.trim()) {
      const candidateIds = Array.isArray(body.candidateIds)
        ? body.candidateIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : null;
      const result = await pushForEmployee({
        monthKey: body.monthKey,
        employeeHrIdCompact: body.employeeHrIdCompact,
        candidateIds,
        actor: access,
      });
      return NextResponse.json({ success: true, ...result });
    }

    throw new Error("Validation: provide candidateId, or employeeHrIdCompact (with an optional candidateIds list).");
  } catch (error) {
    return jsonError(error, "Failed to push this deduction.");
  }
}

/** Withdraw one pushed line: { lineId }. Frees the candidate to be edited and re-pushed. */
export async function DELETE(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "approve");
    assertDeductionsPublishActor(access);

    const body = (await request.json()) as WithdrawBody;
    if (typeof body.lineId !== "string" || !body.lineId.trim()) {
      throw new Error("Validation: lineId is required.");
    }

    const result = await withdrawDeduction({ lineId: body.lineId, actor: access });
    return NextResponse.json({ success: result.ok, ...result });
  } catch (error) {
    return jsonError(error, "Failed to withdraw this deduction.");
  }
}
