import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { updateDeductionDecision } from "@/lib/deductions-governance/service";
import {
  deductionDecisionStatuses,
  type DeductionDecisionStatus,
} from "@/lib/deductions-governance/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string, defaultStatus = 500) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, message: (error as Error).message }, { status: 403 });
  }
  const message = error instanceof Error ? error.message : fallback;
  const lower = message.toLowerCase();
  if (lower.includes("not authenticated")) return NextResponse.json({ success: false, message }, { status: 401 });
  if (lower.includes("forbidden")) return NextResponse.json({ success: false, message }, { status: 403 });
  if (lower.includes("not found")) return NextResponse.json({ success: false, message }, { status: 404 });
  if (lower.includes("invalid") || lower.includes("required") || lower.includes("cannot")) {
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
  return NextResponse.json({ success: false, message }, { status: defaultStatus });
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");
    const body = await request.json();
    const candidateId = String(body.candidateId ?? "").trim();
    const decisionStatus = String(body.decisionStatus ?? "").trim();
    if (!candidateId) {
      return NextResponse.json({ success: false, message: "candidateId is required." }, { status: 400 });
    }
    if (!(deductionDecisionStatuses as readonly string[]).includes(decisionStatus)) {
      return NextResponse.json({ success: false, message: "decisionStatus is invalid." }, { status: 400 });
    }

    const decision = await updateDeductionDecision({
      access,
      appliedDeductionValue: body.appliedDeductionValue == null ? null : Number(body.appliedDeductionValue),
      candidateId,
      decisionReason: String(body.decisionReason ?? ""),
      decisionStatus: decisionStatus as DeductionDecisionStatus,
      hrNote: String(body.hrNote ?? ""),
    });

    return NextResponse.json({ success: true, decision });
  } catch (error) {
    return jsonError(error, "Failed to save deduction decision.");
  }
}
