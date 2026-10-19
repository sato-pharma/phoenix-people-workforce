import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { answerPlaceMatch, loadPlaceMatchBoard } from "@/lib/phoenix-crm/server/place-match-groups";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the third tab of Place checks: every place two or more reps validated, side by side, with the
// questions the system could not settle (owner, 2026-10-17). It is read when the tab is OPENED, not with
// the page — it pages through every validated place and polyclinic, which the other two tabs never need.
// The Super Admin and the SFE Manager: `read` here is gate one and the loader refuses everyone but those two
// before a row is read, so a district manager's board can never reach a colleague's comparison.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const { board, capped } = await loadPlaceMatchBoard(viewer);
    return NextResponse.json({ board: { ...board, capped }, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the places several reps validated.");
  }
}

// POST = his answer to "are these the same place?" — same, different, or take an answer back. One answer
// covers every pair that raised its question, so he is never asked twice.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const saved = await answerPlaceMatch(viewer, await request.json());
    return NextResponse.json({ saved, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the answer.");
  }
}
