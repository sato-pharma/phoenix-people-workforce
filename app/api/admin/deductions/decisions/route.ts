import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { recordDecision } from "@/lib/deductions/service.ts";
import { deductionsDecisionStatuses, type DeductionsDecisionStatus } from "@/lib/deductions/types.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DecisionBody = {
  candidateId?: unknown;
  decisionStatus?: unknown;
  decisionReason?: unknown;
  hrNote?: unknown;
  appliedValue?: unknown;
  appliedAmount?: unknown;
};

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "approve");

    const body = (await request.json()) as DecisionBody;
    if (typeof body.candidateId !== "string" || !body.candidateId.trim()) {
      throw new Error("Validation: candidateId is required.");
    }
    if (
      typeof body.decisionStatus !== "string" ||
      !(deductionsDecisionStatuses as readonly string[]).includes(body.decisionStatus)
    ) {
      throw new Error("Validation: decisionStatus is missing or not recognized.");
    }

    const decision = await recordDecision({
      actor: access,
      candidateId: body.candidateId,
      decisionStatus: body.decisionStatus as DeductionsDecisionStatus,
      decisionReason: typeof body.decisionReason === "string" ? body.decisionReason : "",
      hrNote: typeof body.hrNote === "string" ? body.hrNote : undefined,
      appliedValue: typeof body.appliedValue === "number" ? body.appliedValue : null,
      appliedAmount: typeof body.appliedAmount === "number" ? body.appliedAmount : null,
    });

    return NextResponse.json({ success: true, decision });
  } catch (error) {
    return jsonError(error, "Failed to record deduction decision.");
  }
}
