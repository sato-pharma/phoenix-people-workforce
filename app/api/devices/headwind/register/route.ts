import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import { registerOneHeadwindTablet } from "@/lib/devices/headwind/register-sync";
import { HeadwindCommandInputError } from "@/lib/devices/headwind/target";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Add one managed Headwind tablet to the Device Custody register.
 *
 * 🔴 NEW TABLETS ENTER CUSTODY ONLY WHEN A PERSON CONFIRMS THEM (owner, 2026-10-22). The fleet read
 * used to add an unknown managed tablet to the register by itself; now it only flags it as waiting,
 * and this route is the person's confirmation — one tablet, one press, from its own row.
 *
 * 🔴 THE BODY CARRIES A DEVICE NUMBER AND NOTHING ELSE. The facts written onto the new entry are read
 * from Headwind's own live list on the server, never from the browser, and the tag is numbered against
 * the register as it stands — so a stale page or a forged request can only ask to add a tablet that is
 * already there or already gone, and gets a plain refusal, never a row whose contents it chose. Gate
 * `company_devices:approve` (Super Admin only), same-origin, and the register write carries its own
 * REQUIRED audit row (company_device), exactly as every other way into the register does.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const deviceNumber = typeof payload.deviceNumber === "string" ? payload.deviceNumber : "";
    if (!deviceNumber.trim()) throw new HeadwindCommandInputError("Say which tablet to add to the custody register.");

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    return NextResponse.json(await registerOneHeadwindTablet(deviceNumber, actor), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return headwindErrorResponse(error, "Could not add this tablet to the custody register.");
  }
}
