import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { startServerTimer } from "@/lib/http/server-timing";
import { getMyListBoard } from "@/lib/crm/reps-list-board";
import { readTestFlag, resolvePhoenixCrmViewer, territoryForRead } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { territoryName } from "@/lib/phoenix-crm/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the seat rep's CRM contact list as the Reps List / My List board sees it: grouped by brick,
// the AM · PM · Pharmacies breakdown, the brick coverage and this month's activity beside each row.
//
// THE AUTHORISATION IS THE CRM'S OWN SEAT GATE, REUSED. `territoryForRead` is the first line of
// `loadTerritoryList` — the call behind the List tab — and it refuses a seat the viewer may not open,
// the test persona and the line opening included. So the board is loaded ONLY for a rep whose seat
// this viewer is authorised to read. The board is then scoped to that one rep, and a peer's name is
// withheld exactly as My List withholds it — a manager sees the list, never the roster.
//
// 🔴 THE GATE ALONE, NEVER THE WHOLE LIST LOAD (2026-10-01, "slow to transfer between page and page",
// Phoenix CRM first). This route used to call `loadTerritoryList` for its gate and then read two
// fields of the answer. That ran the ENTIRE List load a second time — the reference-customer mint,
// the six-way read, names, brick names and four iReports360 mirror reads, the company-wide contact
// roster among them — every time the board opened, on top of the `/list` request the tab had already
// made. The seat's occupant and name are all the board needs, and they are exactly what that load's
// `describeTerritory` answered (`repHrId: seat.occupantHrId`, `name: territoryName(seat)`).
export async function GET(request: Request) {
  const timer = startServerTimer("crm_list_board");
  try {
    const access = await resolveAccessContext(request);
    timer.lap("access");
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await timer.measure("viewer", () => resolvePhoenixCrmViewer(access));
    const search = searchOf(request);

    // The seat gate. It throws for a seat outside the viewer's reach, so nothing below can widen it.
    const { seat } = territoryForRead(viewer, search.get("seatId"), readTestFlag(search.get("test")));
    const repHrId = seat.occupantHrId;

    // A vacant territory has no rep and therefore no contact list of its own.
    if (!repHrId) {
      return NextResponse.json({ board: null, success: true }, { headers: timer.headers() });
    }

    const board = await timer.measure("load", () =>
      getMyListBoard({
        params: { month: search.get("month") ?? undefined },
        scope: { agentHrIds: [repHrId], kind: "agents", label: territoryName(seat) },
      }),
    );

    return NextResponse.json({ board, success: true }, { headers: timer.headers() });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the contact list.");
  }
}
