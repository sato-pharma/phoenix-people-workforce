import { NextResponse } from "next/server";

import { hrIdForStorage } from "@/lib/hr-id";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  issueManageEngineCommand,
  isManageEngineCommandId,
  ManageEngineCommandInputError,
} from "@/lib/devices/manageengine/commands";
import { getManageEngineLocation } from "@/lib/devices/manageengine/devices";
import { getManageEngineFleet } from "@/lib/devices/manageengine/fleet";
import { manageEngineErrorResponse } from "@/lib/devices/manageengine/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read the ManageEngine fleet, matched to the custody register. Super Admin only
 * (`company_devices:approve`); a missing bridge credential answers as a setup state, not an error.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");
    const deviceId = new URL(request.url).searchParams.get("deviceId")?.trim();
    if (deviceId) return NextResponse.json(await getManageEngineLocation(deviceId));
    return NextResponse.json(await getManageEngineFleet());
  } catch (error) {
    return manageEngineErrorResponse(error, "Could not read the ManageEngine fleet.");
  }
}

/**
 * Take one remote action on one tablet — lock, restart, reset the screen lock, lost mode on or off,
 * remove company data, or full factory reset.
 *
 * 🔴 EACH PRESS REACHES A REAL TABLET, and the two wipes erase it. Gated on `company_devices:approve`
 * (Super Admin only), CSRF-guarded, and followed by a required audit row that names the tablet.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const deviceId = typeof payload.deviceId === "string" ? payload.deviceId.trim() : "";
    if (!deviceId) throw new ManageEngineCommandInputError("Say which tablet to act on.");
    if (!isManageEngineCommandId(payload.command)) {
      throw new ManageEngineCommandInputError(
        "Unknown action — expected lock, restart, reset lock, lost mode, remove company data or factory reset.",
      );
    }

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    return NextResponse.json(await issueManageEngineCommand({ command: payload.command, deviceId }, actor));
  } catch (error) {
    return manageEngineErrorResponse(error, "Could not take that action on the tablet.");
  }
}
