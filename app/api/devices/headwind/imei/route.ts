import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { listHeadwindDevices } from "@/lib/devices/headwind/devices";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import { recordHeadwindImeis } from "@/lib/devices/headwind/register-sync";
import { getDeviceRegisterData } from "@/lib/devices/service";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Copy the IMEI each Headwind-managed tablet reports into its custody-register entry, where the entry
 * holds none — the Headwind twin of `/api/devices/tablets/imei`.
 *
 * 🔴 IT READS NO BODY. Which entries are written, and with which IMEI, is decided again here from
 * Headwind's live list and the register as they are now: the browser can ask for the copy, never say
 * what it copies. It never overwrites an IMEI somebody typed, and it writes only onto an entry the
 * tablet's own serial number confirms. Gated on `company_devices:approve` (Super Admin only),
 * CSRF-guarded, and every IMEI written carries its own required audit row naming Headwind as the
 * console that reported it.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    const [devices, register] = await Promise.all([listHeadwindDevices(), getDeviceRegisterData()]);
    return NextResponse.json(await recordHeadwindImeis(devices, register.devices, actor), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return headwindErrorResponse(error, "Could not copy the tablets' IMEIs into the custody register.");
  }
}
