import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { HeadwindAppInputError, removeHeadwindApp } from "@/lib/devices/headwind/apps";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Take one app off one Headwind-managed tablet.
 *
 * 🔴 THE REMOVAL IS SILENT ON THE TABLET — the Headwind agent is the device owner, so nothing is
 * shown to the rep and nothing asks them. That is what makes it usable on a kiosk tablet, and it is
 * exactly why the gate is `company_devices:approve` (Super Admin only), the request is same-origin,
 * and the removal writes a REQUIRED audit row naming the tablet and the package.
 *
 * Reading what is installed stays on the fleet route (`?view=apps`) — it rides along in the device
 * record and costs no request of its own. This route only removes.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const deviceNumber = typeof payload.deviceNumber === "string" ? payload.deviceNumber : "";
    const packageName = typeof payload.packageName === "string" ? payload.packageName : "";
    if (!deviceNumber) throw new HeadwindAppInputError("Say which tablet to remove the app from.");
    if (!packageName) throw new HeadwindAppInputError("Say which app to remove.");

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    return NextResponse.json(await removeHeadwindApp({ deviceNumber, packageName }, actor), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return headwindErrorResponse(error, "Could not remove that app from the tablet.");
  }
}
