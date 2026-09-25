import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { manageEngineErrorResponse } from "@/lib/devices/manageengine/http";
import { listManageEngineProfiles } from "@/lib/devices/manageengine/profiles";
import {
  buildRepTabletProfile,
  findRepTabletProfile,
  isPhoenixBuiltRepTabletProfile,
  REP_TABLET_PROFILE_GAPS,
  REP_TABLET_PROFILE_NAME,
  REP_TABLET_PROFILE_SETTINGS,
} from "@/lib/devices/manageengine/rep-tablet-profile";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The company's rep tablet profile in ManageEngine — what it would say, and building it.
 *
 * GET answers what the Rules section needs before anything exists: whether the tenant already holds
 * the profile, every rule Phoenix would write into it, and the three rules a ManageEngine profile
 * cannot carry. Those gaps are part of the answer on purpose — a page that listed only what it does
 * would quietly imply the update window and the app list came with it.
 *
 * POST builds it: create, add the payloads, READ THEM BACK, and publish only if they are there. It
 * reads no body, so the browser can ask for the company's profile and never say what is in it. It is
 * safe to press twice — a tenant that already holds the profile is left untouched. It puts the
 * profile on NO tablet; that is the Rules section on one tablet at a time, and its own audit row.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const existing = findRepTabletProfile(await listManageEngineProfiles());
    return NextResponse.json(
      {
        // False when the tenant's rule set was built in the ManageEngine console rather than by
        // Phoenix. The settings below are then what Phoenix WOULD write, not a reading of that
        // profile, and the card has to say so — claiming otherwise would put this page's word behind
        // values nobody here has read.
        builtByPhoenix: isPhoenixBuiltRepTabletProfile(existing),
        exists: existing !== null,
        gaps: REP_TABLET_PROFILE_GAPS,
        name: existing?.name ?? REP_TABLET_PROFILE_NAME,
        profileId: existing?.profileId ?? null,
        settings: REP_TABLET_PROFILE_SETTINGS,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return manageEngineErrorResponse(error, "Could not read the company's rep tablet profile.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    return NextResponse.json(await buildRepTabletProfile(actor), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return manageEngineErrorResponse(error, "Could not build the rep tablet profile in ManageEngine.");
  }
}
