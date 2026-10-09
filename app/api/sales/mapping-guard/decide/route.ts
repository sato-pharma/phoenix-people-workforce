import { NextResponse } from "next/server";

import { hrIdForStorage } from "@/lib/hr-id";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf } from "@/lib/http/api-errors";
import { decideMappingHolds, listHeldMappingChanges } from "@/lib/sales/mapping-guard";
import { loadHoldDetails } from "@/lib/sales/mapping-guard-detail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Release or refuse held mapping changes — one, or a whole selection of them.
 *
 * The gate is server-side and is the security boundary: the sidebar hiding this link is UX only.
 * `sales:import` is the same permission the Mapping Database editor requires, and the page itself
 * narrows further to Super Admin — releasing a hold is an owner decision by construction, since the
 * whole point of the hold is that somebody else's change was about to replace one of his.
 *
 * `lock` stamps his answer on the customer at confidence 100, which the monthly self-heal skips
 * outright. Without it NEITHER answer survives the next upload (owner, 2026-10-09), which is why
 * the screen sends it on by default and says so in words beside the buttons.
 */
function actorOf(access: Awaited<ReturnType<typeof resolveAccessContext>>): string {
  return hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function fail(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
  }
  // A refusal the database wrote on purpose (for example: the brick a held pharmacy moves to was
  // switched off, so its sales cannot follow). The approval and the sales move are one transaction,
  // so nothing was decided and the hold still waits.
  if ((error as { code?: unknown } | null)?.code === "P0001") {
    return NextResponse.json({ success: false, error: `${errorMessageOf(error)} Nothing was decided.` }, { status: 409 });
  }
  return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}

/** Super Admin only, server-side, before anything is read or written. */
async function assertOwnerAccess(request: Request) {
  const access = await resolveAccessContext(request);
  await assertPermission(access, "sales", "import");
  if (access.role !== "Super Admin" && access.scope !== "system") {
    const forbidden = new Error("Forbidden.") as Error & { status?: number };
    forbidden.status = 403;
    throw forbidden;
  }
  return access;
}

function isForbidden(error: unknown): boolean {
  return isForbiddenError(error) || (error as { status?: unknown } | null)?.status === 403;
}

/**
 * How many holds one click may carry.
 *
 * Each hold is its own database round trip on purpose (`decideMappingHolds`), so a selection of
 * several hundred would run past the request limit with some of them already decided and no way to
 * tell him which. The screen pages the selection and this is the ceiling it enforces.
 */
const MAX_HOLDS_PER_REQUEST = 60;

export async function GET(request: Request) {
  try {
    await assertOwnerAccess(request);
    const holds = await listHeldMappingChanges();
    return NextResponse.json({ details: await loadHoldDetails(holds), holds, success: true });
  } catch (error) {
    if (isForbidden(error)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    return fail(error, "Could not load the held changes.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await assertOwnerAccess(request);

    const body = (await request.json().catch(() => ({}))) as {
      holdId?: unknown;
      holdIds?: unknown;
      decision?: unknown;
      lock?: unknown;
    };
    // `holdId` stays accepted: a page already open when this deploys keeps working.
    const requested = Array.isArray(body.holdIds) ? body.holdIds : [body.holdId];
    const holdIds = [...new Set(requested.map((raw) => Number(raw)).filter((id) => Number.isInteger(id) && id > 0))];
    const decision = String(body.decision ?? "");
    const lock = body.lock === true;

    if (holdIds.length === 0) {
      return NextResponse.json({ success: false, error: "A hold is required." }, { status: 400 });
    }
    if (holdIds.length > MAX_HOLDS_PER_REQUEST) {
      return NextResponse.json(
        { success: false, error: `Decide at most ${MAX_HOLDS_PER_REQUEST} at a time, so every answer is recorded.` },
        { status: 400 },
      );
    }
    if (decision !== "approved" && decision !== "rejected") {
      return NextResponse.json({ success: false, error: "The decision must be approve or reject." }, { status: 400 });
    }

    const outcomes = await decideMappingHolds({ actor: actorOf(access), decision, holdIds, lock });
    const holds = await listHeldMappingChanges();
    const decided = outcomes.filter((outcome) => outcome.ok);

    // Every answer is reported on its own. A hold somebody decided already, or one the database
    // refused because its target brick is switched off, is no reason to hide the ones that did
    // land — the screen names each.
    return NextResponse.json({
      brickMoves: decided
        .filter((outcome) => outcome.brickMove)
        .map((outcome) => ({ brickMove: outcome.brickMove, holdId: outcome.holdId })),
      decided: decided.length,
      failed: outcomes
        .filter((outcome) => !outcome.ok)
        .map((outcome) => ({ holdId: outcome.holdId, reason: outcome.reason })),
      holds,
      locked: decided.filter((outcome) => outcome.locked).length,
      success: decided.length > 0,
    });
  } catch (error) {
    if (isForbidden(error)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    return fail(error, "Could not record that decision.");
  }
}
