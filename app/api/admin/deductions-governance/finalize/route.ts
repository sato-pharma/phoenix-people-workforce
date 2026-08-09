import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { finalizeMonthlyDeductions } from "@/lib/deductions-governance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string, defaultStatus = 500) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, message: (error as Error).message }, { status: 403 });
  }
  const message = clientSafeErrorMessage(error, fallback);
  const lower = message.toLowerCase();
  if (lower.includes("not authenticated")) return NextResponse.json({ success: false, message }, { status: 401 });
  if (lower.includes("forbidden")) return NextResponse.json({ success: false, message }, { status: 403 });
  if (lower.includes("invalid") || lower.includes("required") || lower.includes("no approved")) {
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
    const monthKey = String(body.monthKey ?? "").trim();
    if (!monthKey) {
      return NextResponse.json({ success: false, message: "monthKey is required." }, { status: 400 });
    }
    const result = await finalizeMonthlyDeductions({
      access,
      monthKey,
      notes: String(body.notes ?? ""),
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return jsonError(error, "Failed to finalize monthly deductions.");
  }
}
