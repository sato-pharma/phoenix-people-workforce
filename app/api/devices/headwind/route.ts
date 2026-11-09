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
import { getHeadwindConfigurationFiles } from "@/lib/devices/headwind/configurations";
import { getHeadwindCommandHistory, getHeadwindDeviceDetail } from "@/lib/devices/headwind/detail";
import { getHeadwindLocation, listHeadwindDevices } from "@/lib/devices/headwind/devices";
import { getHeadwindFleet } from "@/lib/devices/headwind/fleet";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import { getHeadwindLocationHistory, switchOnHeadwindLocationCollection } from "@/lib/devices/headwind/locations";
import { listRecordings } from "@/lib/devices/headwind/recordings";
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
      // The fleet read NEVER adds a tablet to the custody register — a person confirms each one
      // (`registerOneHeadwindTablet`, owner rule 2026-10-22); `getHeadwindFleet` keeps its actor
      // argument for call-site compatibility only. The action catalogue rides along so the console can
      // grey the actions this server cannot be sent yet.
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
      // 🔴 THE FILES A TABLET CARRIES ARE THE FILES ON ITS RULES, AND THOSE RULES REACH EVERY TABLET
      // ON THEM — Headwind has no per-tablet file store to read. So this resolves the tablet's own
      // configuration and returns that configuration's file list, and the note says plainly that a
      // file added or removed here reaches all of them, so nobody reads it as one tablet's own folder.
      case "files": {
        const devices = await listHeadwindDevices();
        const device = devices.find((candidate) => candidate.deviceNumber === deviceNumber);
        if (!device) {
          throw new HeadwindCommandInputError(
            "That tablet is not in the Headwind fleet any more. Reload the page and try again from its row.",
          );
        }
        const configurationId = device.configurationId ? Number(device.configurationId) : null;
        if (configurationId === null || !Number.isInteger(configurationId)) {
          return NextResponse.json({
            configurationId: null,
            configurationName: device.configurationName,
            files: [],
            note: "This tablet is not on any set of rules yet, so there are no pushed files to show. Put it on a configuration first.",
          });
        }
        const { configuration, files } = await getHeadwindConfigurationFiles(configurationId);
        return NextResponse.json({
          configurationId,
          configurationName: configuration.name,
          files,
          note:
            `These are the files pushed through this tablet's rules (${configuration.name}). Every tablet on ` +
            "these rules holds them — a file added or removed here reaches all of them at their next check-in.",
        });
      }
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
      // 🔴 THE SCREEN RECORDINGS PHOENIX HOLDS FOR THIS TABLET, newest first, each ready one carrying a
      // short-lived playback link. On-demand captures the tablet uploaded — never a live feed, never
      // calls or messages. Reading is Super Admin only, the same gate as the rest of this route.
      case "recordings":
        return NextResponse.json(await listRecordings(deviceNumber));
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
    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    // 🔴 SWITCHING MOVEMENT HISTORY ON IS A SERVER-WIDE WRITE, SO IT LIVES HERE — behind the CSRF check,
    // the permission and an audit row — and never in the GET that reads a tablet's movements, which is
    // where it used to happen as a side effect of opening the panel.
    if (payload.action === "location-history-on") {
      return NextResponse.json(await switchOnHeadwindLocationCollection(actor));
    }

    const deviceNumber = typeof payload.deviceNumber === "string" ? payload.deviceNumber.trim() : "";
    if (!deviceNumber) throw new HeadwindCommandInputError("Say which tablet to act on.");
    if (!isHeadwindCommandId(payload.command)) {
      throw new HeadwindCommandInputError(
        "Unknown action — expected apply settings, wake the remote app, restart, lock, locate, kiosk mode or factory reset.",
      );
    }

    return NextResponse.json(await issueHeadwindCommand({ command: payload.command, deviceNumber }, actor));
  } catch (error) {
    return headwindErrorResponse(error, "Could not take that action on the tablet.");
  }
}
