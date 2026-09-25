import { NextResponse } from "next/server";

import { hrIdForStorage } from "@/lib/hr-id";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  issueManageEngineCommand,
  isManageEngineCommandId,
  ManageEngineCommandInputError,
} from "@/lib/devices/manageengine/commands";
import { getManageEngineDeviceApps } from "@/lib/devices/manageengine/apps";
import {
  getManageEngineCommandHistory,
  getManageEngineDeviceDetail,
} from "@/lib/devices/manageengine/detail";
import { getManageEngineLocation, requestManageEngineLocation } from "@/lib/devices/manageengine/devices";
import { getManageEngineFleet } from "@/lib/devices/manageengine/fleet";
import { manageEngineErrorResponse } from "@/lib/devices/manageengine/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read the ManageEngine fleet, matched to the custody register, or one tablet in depth. Super Admin
 * only (`company_devices:approve`); a missing bridge credential answers as a setup state, not an
 * error.
 *
 * `?deviceId=…` ALONE KEEPS ITS ORIGINAL MEANING — the tablet's last known position — because the
 * Locate button has been sending exactly that since the bridge shipped, and a page served from a
 * cache must not start reading something else. `view` asks for one of the deeper reads instead:
 * `detail` (everything ManageEngine holds), `apps` (what is installed and what the company could
 * send), `history` (what has been asked of it), `locate` (ask for a fresh position, then read it).
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");
    const params = new URL(request.url).searchParams;
    const deviceId = params.get("deviceId")?.trim();
    if (!deviceId) {
      // The fleet read is also what lets a newly enrolled tablet add itself to the custody register,
      // so it needs the person any such entry is written in the name of — see `fleet.ts`.
      const actor =
        hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
      return NextResponse.json(await getManageEngineFleet(actor));
    }

    switch (params.get("view")?.trim()) {
      case "detail":
        return NextResponse.json(await getManageEngineDeviceDetail(deviceId));
      case "apps":
        return NextResponse.json(await getManageEngineDeviceApps(deviceId));
      case "history":
        return NextResponse.json({ commands: await getManageEngineCommandHistory(deviceId) });
      case "locate":
        return NextResponse.json(await requestManageEngineLocation(deviceId));
      default:
        return NextResponse.json(await getManageEngineLocation(deviceId));
    }
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
