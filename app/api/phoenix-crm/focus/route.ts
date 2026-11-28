import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { changeFocusList, loadFocusCandidates, loadFocusList } from "@/lib/phoenix-crm/server/focus-list";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Focus list (owner, 2026-11-28). GET = the list one viewer reads (the rep's own territory, or a manager's
// tracking over a From–To period); `candidates=1` = the territory's PM customers not on it yet. POST = put a
// PM customer on it, keep a rep's push, or return a customer to the normal list.
//
// Gate one is `read`, as everywhere in the module; gate two is in the service, per territory and per row:
// `territoryForFocusPush`, `canDecideFocus`, `canReturnOwnFocus` (src/lib/phoenix-crm/server/access.ts).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    if (search.get("candidates") === "1") {
      const candidates = await loadFocusCandidates(viewer, { seatId: search.get("seatId") });
      return NextResponse.json({ candidates, success: true });
    }
    const focus = await loadFocusList(viewer, {
      seatId: search.get("seatId"),
      test: search.get("test"),
      from: search.get("from"),
      to: search.get("to"),
    });
    return NextResponse.json({ focus, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the Focus list.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const result = await changeFocusList(viewer, body);
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not change the Focus list.");
  }
}
