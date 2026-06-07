import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { confirmDeductionsPayrollImport } from "@/lib/deductions-governance/payroll-handoff";
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
  if (lower.includes("not found") || lower.includes("no finalized")) {
    return NextResponse.json({ success: false, message }, { status: 404 });
  }
  if (lower.includes("not open") || lower.includes("unmatched") || lower.includes("no payroll batch")) {
    return NextResponse.json({ success: false, message }, { status: 409 });
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
    const result = await confirmDeductionsPayrollImport({
      access,
      monthKey: typeof body.monthKey === "string" ? body.monthKey : undefined,
      summaryId: typeof body.summaryId === "string" ? body.summaryId : undefined,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return jsonError(error, "Failed to import deductions to payroll.");
  }
}
