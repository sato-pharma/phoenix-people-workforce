import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { getMyListBoard } from "@/lib/crm/reps-list-board";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadTerritoryList } from "@/lib/phoenix-crm/server/list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the seat rep's CRM contact list as the Reps List / My List board sees it: grouped by brick,
// the AM · PM · Pharmacies breakdown, the brick coverage and this month's activity beside each row.
//
// THE AUTHORISATION IS THE CRM'S OWN SEAT GATE, REUSED. `loadTerritoryList` already refuses a seat
// the viewer may not open (it is the exact call behind the List tab), so the board is loaded ONLY for
// a rep whose seat this viewer is authorised to read. The board is then scoped to that one rep, and a
// peer's name is withheld exactly as My List withholds it — a manager sees the list, never the roster.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);

    // The seat gate. It throws for a seat outside the viewer's reach, so nothing below can widen it.
    const list = await loadTerritoryList(viewer, search.get("seatId"), search.get("test"));
    const repHrId = list.territory.repHrId;

    // A vacant territory has no rep and therefore no contact list of its own.
    if (!repHrId) {
      return NextResponse.json({ board: null, success: true });
    }

    const board = await getMyListBoard({
      params: { month: search.get("month") ?? undefined },
      scope: { agentHrIds: [repHrId], kind: "agents", label: list.territory.name },
    });

    return NextResponse.json({ board, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the contact list.");
  }
}
