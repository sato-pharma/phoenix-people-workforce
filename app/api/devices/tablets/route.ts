import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { repTabletsErrorResponse } from "@/lib/devices/rep-tablets-http";
import { getRepTabletsState } from "@/lib/devices/rep-tablets-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the Rep Tablets page shows: the tablet rules and app list as Google holds them, the
 * enrolled tablets matched to the custody register, and the register tablets a code can be made for.
 *
 * 🔴 GATED ON `company_devices:approve` — Super Admin only, like Managed Google Play. The register's
 * own `read` is HR Operations' paperwork permission; this page is the door to every rep's tablet,
 * and even reading it lists each tablet's serial, IMEI and holder straight from Google.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    return NextResponse.json(await getRepTabletsState(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return repTabletsErrorResponse(error, "Could not load the rep tablets.");
  }
}
