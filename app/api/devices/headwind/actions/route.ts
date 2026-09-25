import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { headwindActionCatalogue, HeadwindActionError, takeHeadwindAction } from "@/lib/devices/headwind/actions";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The custody actions — lock, lost mode, factory reset, reset the screen lock, ring the alarm, show a
 * message, and the one that cannot be done.
 *
 * 🔴 GET IS NOT DECORATION. It asks this particular Headwind box what it can actually honour right
 * now, and every answer carries the reason it cannot when it cannot. The console draws from this, so
 * a button that appears is a button that works, and an action that is out of reach is a sentence
 * saying what would put it in reach — never a control that greys out with no explanation.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");
    return NextResponse.json({ actions: await headwindActionCatalogue() }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return headwindErrorResponse(error, "Could not read what this server can do to a tablet.");
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
    if (!deviceNumber) throw new HeadwindActionError("Say which tablet.");

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    return NextResponse.json(
      await takeHeadwindAction(
        {
          action: payload.action,
          deviceNumber,
          message: typeof payload.message === "string" ? payload.message : null,
        },
        actor,
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return headwindErrorResponse(error, "Could not take that action on the tablet.");
  }
}
