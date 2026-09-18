import { NextResponse } from "next/server";

import { hrIdForStorage } from "@/lib/hr-id";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { repTabletsErrorResponse } from "@/lib/devices/rep-tablets-http";
import { recordReportedImeis } from "@/lib/devices/rep-tablets-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Copy the IMEI each enrolled tablet reports to Google into its custody-register entry, where the
 * entry holds none. The Rep Tablets page calls it by itself when a load finds one missing.
 *
 * 🔴 IT READS NO BODY. Which entries are written, and with which IMEI, is decided again on the server
 * from Google's list and the register as they are now — the browser can ask for the copy, never say
 * what it copies. It never overwrites an IMEI somebody typed. Gated on `company_devices:approve`
 * (Super Admin only), CSRF-guarded, and every IMEI written carries its own required audit row.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    return NextResponse.json(await recordReportedImeis(actor), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return repTabletsErrorResponse(error, "Could not copy the tablets' IMEIs into the custody register.");
  }
}
