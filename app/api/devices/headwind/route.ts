import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { getHeadwindDeviceApps } from "@/lib/devices/headwind/apps";
import {
  headwindCommandCatalogue,
  isHeadwindCommandId,
  issueHeadwindCommand,
  HeadwindCommandInputError,
} from "@/lib/devices/headwind/commands";
import { getHeadwindCommandHistory, getHeadwindDeviceDetail } from "@/lib/devices/headwind/detail";
import { getHeadwindLocation, listHeadwindDevices } from "@/lib/devices/headwind/devices";
import { getHeadwindFleet } from "@/lib/devices/headwind/fleet";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import { getHeadwindLocationHistory } from "@/lib/devices/headwind/locations";
import { rustDeskPackageName } from "@/lib/devices/rustdesk/config";
import { isRustDeskSessionMode, rustDeskTarget } from "@/lib/devices/rustdesk/session";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read the Headwind fleet, matched to the custody register, or one tablet in depth. Super Admin only
 * (`company_devices:approve`); a missing bridge credential answers as a setup state, not an error.
 *
 * `?deviceNumber=…` alone gives the tablet's last known position, the way the ManageEngine route
 * answers a bare `deviceId`. `view` asks for one of the deeper reads instead: `detail` (everything
 * Headwind holds), `apps` (what is installed), `history` (what Phoenix has done to it), `locations`
 * (where it has been, each row naming its source), `screen` (where a remote screen session would
 * connect — 🔴 a target, never a credential).
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");
    const params = new URL(request.url).searchParams;
    const deviceNumber = params.get("deviceNumber")?.trim();
    if (!deviceNumber) {
      // The fleet read is also what lets a newly enrolled tablet add itself to the custody register,
      // so it needs the person any such entry is written in the name of — see `fleet.ts`. The action
      // catalogue rides along so the console can grey the actions this server cannot be sent yet.
      const actor =
        hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
      const fleet = await getHeadwindFleet(actor);
      return NextResponse.json({ ...fleet, commands: headwindCommandCatalogue() });
    }

    switch (params.get("view")?.trim()) {
      case "detail":
        return NextResponse.json(await getHeadwindDeviceDetail(deviceNumber));
      case "apps":
        return NextResponse.json(await getHeadwindDeviceApps(deviceNumber, rustDeskPackageName()));
      case "history":
        return NextResponse.json(await getHeadwindCommandHistory(deviceNumber));
      // 🔴 WHERE THE TABLET HAS BEEN, EVERY ROW SAYING WHICH SOURCE IT CAME FROM. The two are never
      // blended: one is the position that rides on each check-in, the other the movement plugin's own
      // record. Blending them draws a confident line through places a tablet never went.
      case "locations":
        return NextResponse.json(await getHeadwindLocationHistory(deviceNumber));
      case "screen": {
        const mode = params.get("mode")?.trim();
        if (!isHeadwindScreenMode(mode)) {
          throw new HeadwindCommandInputError("Say whether to watch the screen or to take control of it.");
        }
        const devices = await listHeadwindDevices();
        const device = devices.find((candidate) => candidate.deviceNumber === deviceNumber);
        if (!device) {
          throw new HeadwindCommandInputError(
            "That tablet is not in the Headwind fleet any more. Reload the page and try again from its row.",
          );
        }
        return NextResponse.json(rustDeskTarget({ mode, rustDeskId: device.rustDeskId }));
      }
      default:
        return NextResponse.json(await getHeadwindLocation(deviceNumber));
    }
  } catch (error) {
    return headwindErrorResponse(error, "Could not read the Headwind fleet.");
  }
}

function isHeadwindScreenMode(value: unknown): value is "view" | "control" {
  return isRustDeskSessionMode(value);
}

/**
 * Take one remote action on one tablet — apply its settings, wake the remote app, restart, lock,
 * locate, kiosk on or off, or the full factory reset.
 *
 * 🔴 EACH PRESS REACHES A REAL TABLET, and the factory reset erases it. Gated on
 * `company_devices:approve` (Super Admin only), CSRF-guarded, and followed by a required audit row
 * naming the tablet. An action whose wire name is not confirmed yet is refused with 501 and a plain
 * sentence — never sent as a guess that would report a success reaching nothing.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const deviceNumber = typeof payload.deviceNumber === "string" ? payload.deviceNumber.trim() : "";
    if (!deviceNumber) throw new HeadwindCommandInputError("Say which tablet to act on.");
    if (!isHeadwindCommandId(payload.command)) {
      throw new HeadwindCommandInputError(
        "Unknown action — expected apply settings, wake the remote app, restart, lock, locate, kiosk mode or factory reset.",
      );
    }

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    return NextResponse.json(await issueHeadwindCommand({ command: payload.command, deviceNumber }, actor));
  } catch (error) {
    return headwindErrorResponse(error, "Could not take that action on the tablet.");
  }
}
