import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import { HeadwindWipeError, headwindWipeScope, wipeHeadwindDevice } from "@/lib/devices/headwind/wipe";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Erase the company's data from one tablet, leaving the tablet itself enrolled and working.
 *
 * GET hands back the scope in plain words so the console can print what is about to go, beside the
 * second press — it takes no arguments and touches no tablet. POST does it.
 *
 * 🔴 THE SCOPE IS NOT A PARAMETER. The body carries a tablet and nothing else: what a wipe erases is
 * the owner's own decision, fixed in `wipe.ts`, and a wipe that can be aimed from a request body is a
 * wipe that can be mis-aimed. Gate `company_devices:approve` (Super Admin only), same-origin, and a
 * required audit row naming the tablet and every instruction sent.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");
    return NextResponse.json(headwindWipeScope(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return headwindErrorResponse(error, "Could not read what a corporate wipe erases.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const deviceNumber = typeof payload.deviceNumber === "string" ? payload.deviceNumber : "";
    if (!deviceNumber) throw new HeadwindWipeError("Say which tablet to erase the company's data from.");

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    return NextResponse.json(await wipeHeadwindDevice({ deviceNumber }, actor), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return headwindErrorResponse(error, "Could not erase the company's data from that tablet.");
  }
}
