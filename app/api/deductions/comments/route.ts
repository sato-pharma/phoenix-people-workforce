import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { addDeductionComment } from "@/lib/deductions-governance/service";
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
  if (lower.includes("required") || lower.includes("comment") || lower.includes("only after")) {
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
  return NextResponse.json({ success: false, message }, { status: defaultStatus });
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");
    const body = await request.json();
    const candidateId = String(body.candidateId ?? "").trim();
    if (!candidateId) {
      return NextResponse.json({ success: false, message: "candidateId is required." }, { status: 400 });
    }
    const comment = await addDeductionComment({
      access,
      body: String(body.body ?? ""),
      candidateId,
    });
    return NextResponse.json({ success: true, comment });
  } catch (error) {
    return jsonError(error, "Failed to save deduction comment.");
  }
}
