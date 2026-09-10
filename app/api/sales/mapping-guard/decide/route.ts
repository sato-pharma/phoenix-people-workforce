import { NextResponse } from "next/server";

import { hrIdForStorage } from "@/lib/hr-id";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { decideMappingHold, listHeldMappingChanges } from "@/lib/sales/mapping-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Release or refuse one held mapping change.
 *
 * The gate is server-side and is the security boundary: the sidebar hiding this link is UX only.
 * `sales:import` is the same permission the Mapping Database editor requires, and the page itself
 * narrows further to Super Admin — releasing a hold is an owner decision by construction, since the
 * whole point of the hold is that somebody else's change was about to replace one of his.
 */
function actorOf(access: Awaited<ReturnType<typeof resolveAccessContext>>): string {
  return hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function fail(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
  }
  return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    return NextResponse.json({ success: true, holds: await listHeldMappingChanges() });
  } catch (error) {
    return fail(error, "Could not load the held changes.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as { holdId?: unknown; decision?: unknown };
    const holdId = Number(body.holdId);
    const decision = String(body.decision ?? "");
    if (!Number.isInteger(holdId) || holdId <= 0) {
      return NextResponse.json({ success: false, error: "A hold is required." }, { status: 400 });
    }
    if (decision !== "approved" && decision !== "rejected") {
      return NextResponse.json({ success: false, error: "The decision must be approve or reject." }, { status: 400 });
    }

    const result = await decideMappingHold({ actor: actorOf(access), decision, holdId });
    // A hold somebody already decided is not an error to shout about — the screen just refreshes.
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.reason ?? "That change was already decided." }, { status: 409 });
    }
    return NextResponse.json({ success: true, holds: await listHeldMappingChanges() });
  } catch (error) {
    return fail(error, "Could not record that decision.");
  }
}
