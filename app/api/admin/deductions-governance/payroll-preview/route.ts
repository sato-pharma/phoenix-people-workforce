import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { previewDeductionsPayrollImport } from "@/lib/deductions-governance/payroll-handoff";

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
  return NextResponse.json({ success: false, message }, { status: defaultStatus });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");
    const url = new URL(request.url);
    const preview = await previewDeductionsPayrollImport({
      access,
      monthKey: url.searchParams.get("monthKey") ?? undefined,
      summaryId: url.searchParams.get("summaryId") ?? undefined,
    });
    return NextResponse.json({ success: true, preview });
  } catch (error) {
    return jsonError(error, "Failed to preview deductions payroll import.");
  }
}
