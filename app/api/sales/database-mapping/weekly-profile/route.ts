import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { deactivateWeeklyColumnProfile, saveWeeklyColumnProfile, type WeeklyColumnProfileInput } from "@/lib/sales/weekly/weekly-column-profile-admin";
import { listEditableWeeklyContracts } from "@/lib/sales/weekly/weekly-column-profile-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Governed read/write for the WEEKLY distributor column-profile override (editor under Weekly Sales).
// Permission is enforced here (service-role bypasses RLS); the page additionally gates Super Admin/system.

function actor(access: Awaited<ReturnType<typeof resolveAccessContext>>): string {
  return resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function fail(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
  }
  if (error instanceof SalesWorkflowError) {
    return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ success: false, error: error instanceof Error ? error.message : fallback }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");
    const contracts = await listEditableWeeklyContracts();
    return NextResponse.json({ success: true, contracts });
  } catch (error) {
    return fail(error, "Failed to load weekly column profiles.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");
    const body = (await request.json().catch(() => ({}))) as { action?: string; distributorCode?: string; profile?: WeeklyColumnProfileInput };
    if (String(body.action ?? "save") === "reset") {
      const result = await deactivateWeeklyColumnProfile(String(body.distributorCode ?? ""), actor(access));
      return NextResponse.json({ success: true, message: `Reset ${result.distributorCode} to the built-in mapping.` });
    }
    if (!body.profile) return NextResponse.json({ success: false, error: "Missing profile payload." }, { status: 400 });
    const result = await saveWeeklyColumnProfile(body.profile, actor(access));
    return NextResponse.json({ success: true, message: `Saved weekly column mapping for ${result.distributorCode}.` });
  } catch (error) {
    return fail(error, "Failed to save weekly column profile.");
  }
}
