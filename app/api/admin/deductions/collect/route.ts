import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { collectAllCandidatesForMonth } from "@/lib/deductions/collect.ts";
import { assertDeductionsDecisionActor } from "@/lib/deductions/permissions.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CollectBody = {
  month?: unknown;
  year?: unknown;
};

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "create");
    assertDeductionsDecisionActor(access);

    const body = (await request.json().catch(() => ({}))) as CollectBody;
    const month = Number(body.month);
    const year = Number(body.year);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error("Validation: month must be an integer between 1 and 12.");
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new Error("Validation: year must be an integer between 2000 and 2100.");
    }

    const results = await collectAllCandidatesForMonth({
      month,
      year,
      createdBy: access.hrId ?? access.loginId ?? "unknown",
    });

    return NextResponse.json({ success: true, results });
  } catch (error) {
    return jsonError(error, "Failed to run the monthly deductions collection.");
  }
}
