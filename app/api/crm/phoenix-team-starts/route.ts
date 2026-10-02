import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  assertPhoenixTeamStartsAdmin,
  PhoenixTeamStartRefusal,
  setPhoenixTeamStart,
} from "@/lib/crm/phoenix-team-starts-server";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Start or stop counting a TEAM from Phoenix CRM on every other screen (owner, 2026-10-02: "Only when I
// start it"). Delta (1)'s 3 October start is his own ruling, seeded by the migration; every other team
// starts here and nowhere else — no plan, visit or trigger starts one.
//
// SUPER ADMIN ONLY, gated twice before anything is written: the role (assertPhoenixTeamStartsAdmin) and
// the matrix permission `crm_visits:update`. The write is the security-definer function
// phoenix_crm_set_team_start, which re-checks every rule — a Saturday, never before the first day of the
// current Cairo month, no two starts on one day — and only the service role may call it. It writes the
// audit row itself, in the same transaction, with what the team was before and after: a start or a stop
// changes what the field-work compliance matrix and the deductions connectors read for every rep of it.
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertPhoenixTeamStartsAdmin(access);
    await assertPermission(access, "crm_visits", "update");

    const body = (await request.json().catch(() => ({}))) as { action?: unknown; teamSeatId?: unknown; day?: unknown };
    const action = body.action === "start" || body.action === "stop" ? body.action : null;
    const teamSeatId = typeof body.teamSeatId === "string" ? body.teamSeatId.trim() : "";
    const day = typeof body.day === "string" && body.day.trim() ? body.day.trim().slice(0, 10) : null;
    if (!action || !teamSeatId || (action === "start" && !day)) {
      return NextResponse.json({ error: "Choose the team and the Saturday, then try again." }, { status: 400 });
    }
    const actorHrId = hrIdForStorage(access.hrId);
    if (!actorHrId) {
      return NextResponse.json({ error: "Your account carries no HR id, so the change cannot be recorded." }, { status: 403 });
    }

    const change = await setPhoenixTeamStart({ action, teamSeatId, day, actorHrId, actorLoginId: access.loginId ?? null });
    return NextResponse.json({ change }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PhoenixTeamStartRefusal) return NextResponse.json({ error: error.message }, { status: 409 });
    if (isForbiddenError(error)) return NextResponse.json({ error: "Only the Super Admin starts or stops a team." }, { status: 403 });
    return NextResponse.json({ error: "The team could not be changed. Reload the page and try again." }, { status: 500 });
  }
}
