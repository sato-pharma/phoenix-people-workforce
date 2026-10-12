import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { withdrawDailyLine } from "@/lib/daily-deductions/release.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WithdrawBody = {
  lineId?: unknown;
};

/** Take ONE released deduction back out of the published snapshot. */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "approve");
    // assertDailyDeductionsPublishActor runs inside withdrawDailyLine (Super Admin).

    const body = (await request.json()) as WithdrawBody;
    if (typeof body.lineId !== "string" || !body.lineId) {
      throw new Error("Validation: lineId is required.");
    }

    const result = await withdrawDailyLine({ lineId: body.lineId, actor: access });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return jsonError(error, "Failed to withdraw the released deduction.");
  }
}
