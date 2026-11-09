import { NextResponse } from "next/server";

import { hrIdForStorage } from "@/lib/hr-id";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { repTabletsErrorResponse } from "@/lib/devices/rep-tablets-http";
import { getRepTabletsState } from "@/lib/devices/rep-tablets-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the Rep Tablets page shows: the tablet rules and app list as Google holds them, the
 * enrolled tablets matched to the custody register, and the register tablets a code can be made for.
 * 🔒 THIS READ ADDS NOTHING TO THE CUSTODY REGISTER (owner, 2026-10-22: a new tablet enters Device
 * Custody only when a person confirms it). An enrolled tablet the register does not know is COUNTED
 * (`pendingRegistration`) and a person adds it; never restore the auto-create this comment once
 * described.
 *
 * 🔴 GATED ON `company_devices:approve` — Super Admin only, like Managed Google Play. The register's
 * own `read` is HR Operations' paperwork permission; this page is the door to every rep's tablet,
 * and even reading it lists each tablet's serial, IMEI and holder straight from Google.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    return NextResponse.json(await getRepTabletsState(actor), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return repTabletsErrorResponse(error, "Could not load the rep tablets.");
  }
}
