import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import { HeadwindRemoteScreenIdError, setHeadwindRemoteScreenId } from "@/lib/devices/headwind/remote-screen-id";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record the RustDesk ID of one Headwind-managed tablet — the number a screen session is aimed at.
 *
 * 🔴 THIS ROUTE EXISTS BECAUSE THE HEADWIND CONSOLE CANNOT SHOW THAT FIELD. It lives in `custom1`,
 * which the Community console only draws when `settings.customPropertyName1` is named — it is `null`
 * here, and no screen in that console sets it. Without this route the one number the remote screen
 * needs has nowhere a person can type it.
 *
 * Same gate as every other write in this bridge: `company_devices:approve` (Super Admin only),
 * same-origin, and a REQUIRED audit row naming the tablet, the old ID and the new one. An empty value
 * clears the ID, which is what a re-enrolled tablet needs — RustDesk gives it a new one, and the old
 * number would otherwise keep aiming sessions at a device that no longer answers.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const deviceNumber = typeof payload.deviceNumber === "string" ? payload.deviceNumber : "";
    const remoteScreenId = typeof payload.remoteScreenId === "string" ? payload.remoteScreenId : "";
    if (!deviceNumber) throw new HeadwindRemoteScreenIdError("Say which tablet this ID belongs to.");

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    return NextResponse.json(await setHeadwindRemoteScreenId({ deviceNumber, remoteScreenId }, actor), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return headwindErrorResponse(error, "Could not record the tablet's remote screen ID.");
  }
}
