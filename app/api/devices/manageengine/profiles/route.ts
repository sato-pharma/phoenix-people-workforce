import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { manageEngineErrorResponse } from "@/lib/devices/manageengine/http";
import {
  changeManageEngineProfile,
  getManageEngineProfileState,
  listManageEngineProfiles,
  ManageEngineProfileInputError,
} from "@/lib/devices/manageengine/profiles";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The rules a rep tablet carries — ManageEngine calls them profiles.
 *
 * `?deviceId=…` answers with what that tablet is carrying and what else it could be put on; without
 * one, the company's whole Android profile list. Super Admin only (`company_devices:approve`), and a
 * missing bridge credential answers as a setup state rather than an error.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const deviceId = new URL(request.url).searchParams.get("deviceId")?.trim();
    const body = deviceId
      ? await getManageEngineProfileState(deviceId)
      : { profiles: await listManageEngineProfiles() };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return manageEngineErrorResponse(error, "Could not read the rules on that tablet.");
  }
}

/**
 * Put one of the company's rule sets on a tablet, or take one off.
 *
 * 🔴 THIS CHANGES WHAT A TABLET IN A REP'S HANDS IS ALLOWED TO DO — its screen lock, its kiosk
 * pinning, what the rep may reach — so it carries the same guard as the remote commands beside it:
 * `company_devices:approve` (Super Admin only), same-origin, and a REQUIRED audit row written by the
 * service naming the tablet by its custody asset tag and the rules by their own name. Both ids are
 * checked against the live fleet and the company's own profile list before anything is sent.
 *
 * ONE VERB, TWO CHANGES. ManageEngine takes a POST to associate and a DELETE to disassociate, both
 * with a body; a browser DELETE carrying a body is the one shape proxies drop, so the page sends
 * `change` in a POST and this route dispatches, exactly as the apps route does.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const deviceId = typeof payload.deviceId === "string" ? payload.deviceId.trim() : "";
    const profileId = typeof payload.profileId === "string" ? payload.profileId.trim() : "";

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    switch (payload.change) {
      case "APPLY":
        return NextResponse.json(await changeManageEngineProfile({ action: "associate", deviceId, profileId }, actor));
      case "REMOVE":
        return NextResponse.json(
          await changeManageEngineProfile({ action: "disassociate", deviceId, profileId }, actor),
        );
      default:
        throw new ManageEngineProfileInputError(
          "Unknown change — expected putting rules on a tablet or taking them off.",
        );
    }
  } catch (error) {
    return manageEngineErrorResponse(error, "Could not change the rules on that tablet.");
  }
}
