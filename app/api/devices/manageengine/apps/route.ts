import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  installManageEngineApp,
  listManageEngineAppRepository,
  ManageEngineAppInputError,
  refreshManageEngineAppStatus,
  removeManageEngineApp,
} from "@/lib/devices/manageengine/apps";
import { manageEngineErrorResponse } from "@/lib/devices/manageengine/http";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the company app repository holds — the apps Phoenix is able to send to a tablet.
 *
 * A read, gated the same as everything else on this page (`company_devices:approve`, Super Admin
 * only). It is the list the repository card renders, and the list that tells the owner whether an
 * upload actually landed.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");
    return NextResponse.json({ apps: await listManageEngineAppRepository() });
  } catch (error) {
    return manageEngineErrorResponse(error, "Could not read the company app repository.");
  }
}

/**
 * Put an app on a rep's tablet, take one off, or ask the tablet for its app list again.
 *
 * 🔴 THE FIRST TWO REACH A REAL TABLET IN A REP'S HANDS, so this route carries the same guard as the
 * remote commands beside it: `company_devices:approve` (Super Admin only), same-origin, and a
 * REQUIRED audit row written by the service naming the tablet by its custody asset tag and the app
 * by its name. Nothing is trusted from the browser except the ids, and both are checked against the
 * live fleet before anything is sent.
 *
 * ONE VERB, THREE CHANGES. Install and remove are `POST … /apps` and `DELETE … /apps` at
 * ManageEngine, but a browser sending a DELETE with a body is the one shape that gets dropped by
 * proxies and rewritten by fetch polyfills, so the page sends `change` in a POST and this route
 * dispatches. The audit rows still record which of the three happened.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const deviceId = typeof payload.deviceId === "string" ? payload.deviceId.trim() : "";
    const appId = typeof payload.appId === "string" ? payload.appId.trim() : "";
    const appName = typeof payload.appName === "string" ? payload.appName : null;
    const releaseLabelId = typeof payload.releaseLabelId === "string" ? payload.releaseLabelId : null;

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    switch (payload.change) {
      case "INSTALL":
        return NextResponse.json(await installManageEngineApp({ appId, appName, deviceId, releaseLabelId }, actor));
      case "REMOVE":
        return NextResponse.json(await removeManageEngineApp({ appId, appName, deviceId }, actor));
      case "REFRESH":
        return NextResponse.json(await refreshManageEngineAppStatus(deviceId));
      default:
        throw new ManageEngineAppInputError("Unknown change — expected install, remove or refresh.");
    }
  } catch (error) {
    return manageEngineErrorResponse(error, "Could not change the apps on that tablet.");
  }
}
