import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  getHeadwindConfiguration,
  HeadwindConfigurationError,
  linkHeadwindApp,
  linkHeadwindFile,
  listHeadwindConfigurations,
  moveHeadwindDeviceToConfiguration,
  setHeadwindBranding,
} from "@/lib/devices/headwind/configurations";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The sets of rules the tablets follow.
 *
 * GET lists them, or with `?configurationId=` reads one — the FACTS and the home-screen look only.
 * 🔴 The whole configuration object is never returned to a browser: it carries the tablet's admin
 * password in clear text, and an admin screen that ships it to the front end has published it to
 * everything between here and there.
 *
 * POST does one of four things, named by `change`: `branding`, `app`, `file`, `device`. Each writes
 * its own required audit row naming what changed and never the object.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const raw = new URL(request.url).searchParams.get("configurationId");
    if (raw) {
      const configurationId = Number(raw);
      if (!Number.isInteger(configurationId)) {
        throw new HeadwindConfigurationError("That is not a set of tablet rules.");
      }
      return NextResponse.json(await getHeadwindConfiguration(configurationId), {
        headers: { "cache-control": "no-store" },
      });
    }
    return NextResponse.json(await listHeadwindConfigurations(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return headwindErrorResponse(error, "Could not read the tablet rules.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const configurationId = Number(payload.configurationId);
    const headers = { "cache-control": "no-store" };

    switch (payload.change) {
      case "branding":
        return NextResponse.json(
          await setHeadwindBranding(
            {
              backgroundColor: readText(payload.backgroundColor),
              backgroundImageUrl: readText(payload.backgroundImageUrl),
              configurationId,
              desktopHeader: readText(payload.desktopHeader),
              desktopHeaderTemplate: readText(payload.desktopHeaderTemplate),
              iconSize: readText(payload.iconSize),
              textColor: readText(payload.textColor),
            },
            actor,
          ),
          { headers },
        );
      case "app":
        return NextResponse.json(
          await linkHeadwindApp(
            {
              action: (payload.action === 0 || payload.action === 2 ? payload.action : 1) as 0 | 1 | 2,
              applicationId: Number(payload.applicationId),
              configurationId,
            },
            actor,
          ),
          { headers },
        );
      case "file":
        return NextResponse.json(
          await linkHeadwindFile(
            { configurationId, fileId: Number(payload.fileId), remove: payload.remove === true },
            actor,
          ),
          { headers },
        );
      case "device":
        return NextResponse.json(
          await moveHeadwindDeviceToConfiguration(
            {
              configurationId,
              deviceNumber: typeof payload.deviceNumber === "string" ? payload.deviceNumber : "",
            },
            actor,
          ),
          { headers },
        );
      default:
        throw new HeadwindConfigurationError(
          "Say what to change on the tablet rules — the look, an app, a file, or which tablet follows them.",
        );
    }
  } catch (error) {
    return headwindErrorResponse(error, "Could not change the tablet rules.");
  }
}

/**
 * A field the caller did not send is left alone; a field sent empty is CLEARED.
 *
 * 🔴 THE DIFFERENCE IS THE WHOLE BEHAVIOUR OF THE FORM. Reading a missing field as an empty string
 * would blank every branding field the form did not happen to include.
 */
function readText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return value.trim() ? value.trim() : null;
}
