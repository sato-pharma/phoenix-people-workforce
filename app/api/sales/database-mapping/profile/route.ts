import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { deactivateDistributorProfile, saveDistributorProfile, type DistributorProfileInput } from "@/lib/sales/distributor-profile-admin";
import { listEditableProfiles } from "@/lib/sales/normalizer/distributor-profile-store";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Governed read/write for the MONTHLY distributor-profile override (editor under Sales Operations).
// Permission is enforced here (service-role bypasses RLS); the page additionally gates Super Admin/system.

function actor(access: Awaited<ReturnType<typeof resolveAccessContext>>): string {
  return resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function fail(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
  }
  if (error instanceof SalesWorkflowError) {
    return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const profiles = await listEditableProfiles();
    return NextResponse.json({ success: true, profiles });
  } catch (error) {
    return fail(error, "Failed to load distributor profiles.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const body = (await request.json().catch(() => ({}))) as { action?: string; distributorCode?: string; profile?: DistributorProfileInput };
    if (String(body.action ?? "save") === "reset") {
      const result = await deactivateDistributorProfile(String(body.distributorCode ?? ""), actor(access));
      return NextResponse.json({ success: true, message: `Reset ${result.distributorCode} to the built-in mapping.` });
    }
    if (!body.profile) return NextResponse.json({ success: false, error: "Missing profile payload." }, { status: 400 });
    const result = await saveDistributorProfile(body.profile, actor(access));
    return NextResponse.json({ success: true, message: `Saved column mapping for ${result.distributorCode}.` });
  } catch (error) {
    return fail(error, "Failed to save distributor profile.");
  }
}
