import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { answerLineLookalike, loadLineLookalikeBoard } from "@/lib/phoenix-crm/server/line-lookalikes";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the Place checks tab "Same customer, other line" (owner, 2026-11-16: "same customer diff rep same area
// diff line", then "Fix rule + review list"): every customer still waiting on one line whom another line of
// the same area has validated under a name written another way. Read when the tab is OPENED — it reads the
// whole country's AM and PM lists. `read` is gate one; the loader refuses everyone but the Super Admin
// before a row is read.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const board = await loadLineLookalikeBoard(viewer);
    return NextResponse.json({ board, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the customers on another line.");
  }
}

// POST = his answer about one pair: "same" validates the waiting row from the other line's places now;
// "not_same" keeps the pair off the list for good. Nothing on the list is validated without it.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const saved = await answerLineLookalike(viewer, await request.json());
    return NextResponse.json({ saved, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the answer.");
  }
}
