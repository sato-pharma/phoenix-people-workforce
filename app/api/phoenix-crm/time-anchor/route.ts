import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { issueTimeAnchor } from "@/lib/phoenix-crm/server/time-anchor";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = a server-minted time anchor for the phone to measure against while it has no signal.
//
// The owner's requirement, 2026-09-27: "I want the Cairo time, but I don't want the time on the
// phone because they may install an app that changes the time in the phone." So the phone is handed
// a starting point only the server can set, and later sends how much MONOTONIC time has elapsed
// since — never a timestamp of its own.
//
// It is a POST because it writes a row, and it is gated like the photo slot it accompanies: the same
// `phoenix_crm:create` permission, the same rate-limit shape, and the same audience as entering a
// visit, so a manager in a dead spot is not locked out of a double visit.
//
// Nothing a rep sees depends on this succeeding. If it fails he simply has no anchor, and a visit
// captured afterwards is dated at arrival and marked for the board — silently, as Golden Rule #1
// requires.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const anchor = await issueTimeAnchor(viewer, body);
    return NextResponse.json({ anchor, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not take a time check.");
  }
}
