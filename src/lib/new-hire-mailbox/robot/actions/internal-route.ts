import { NextResponse } from "next/server";

import { refuseUnlessRobot } from "@/lib/platform/worker-only-route";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

import { parseRobotActor, type RobotActor } from "./actor";
import type { RobotAction } from "./forward";

/**
 * The shared door of the four robot routes on the robot service (`/api/internal/mailbox-robot/*`,
 * audit REC-075). In this order, before anything is read from the body:
 *   1. the bearer must be CRON_SECRET — `assertCronAuthorized`, the repo's one cron-secret check,
 *      constant-time and logged on a refusal;
 *   2. this must be the robot service (503 `wrong_process` anywhere else, so a robot browser never
 *      opens on the website or the worker through this door);
 *   3. the forwarded body must name the Super Admin who pressed the button, so the audit row the
 *      action writes is attributed to them.
 * The website has already checked that person's session, CSRF, role and rate limit.
 */
export async function handleInternalRobotRequest(
  request: Request,
  action: RobotAction,
  run: (input: { actor: RobotActor; request: Record<string, unknown> }) => Promise<NextResponse>,
): Promise<NextResponse> {
  const job = `internal/mailbox-robot/${action}`;
  const denied = assertCronAuthorized(request, job);
  if (denied) return denied;
  const wrongProcess = refuseUnlessRobot(job);
  if (wrongProcess) return wrongProcess;

  const body = (await request.json().catch(() => null)) as { actor?: unknown; request?: unknown } | null;
  const actor = parseRobotActor(body?.actor);
  if (!actor) {
    return NextResponse.json(
      { message: "The forwarded request does not say who asked for it, so nothing was run.", success: false },
      { status: 400 },
    );
  }
  const forwarded = body?.request && typeof body.request === "object" ? (body.request as Record<string, unknown>) : {};
  return run({ actor, request: forwarded });
}

/**
 * The live-only robot actions (the App Passwords capture and the rehearsal) open a browser only on an
 * explicit `dryRun: false` in the forwarded request — the same default every robot route carries. The
 * website answers a dry run itself and never forwards one, so anything else here is refused.
 */
export function refuseUnlessLive(forwarded: Record<string, unknown>): NextResponse | null {
  if (forwarded.dryRun === false) return null;
  return NextResponse.json(
    { message: "Only a live run is forwarded to the robot service; a dry run is answered by the website. Nothing was opened.", success: false },
    { status: 400 },
  );
}
