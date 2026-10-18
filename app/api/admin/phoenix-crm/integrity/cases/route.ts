import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { canSettleIntegrityCases, loadIntegrityBoard } from "@/lib/phoenix-crm/server/integrity-board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET = the open location cases, for the one-by-one review on Place checks (owner, 2026-10-18: "make
 * the place checks, integrity cases, all place checks tabs, but in tabs").
 *
 * The Place checks page does not read this board, and must not on every visit: the review asks for it
 * the first time its Integrity cases tab is opened, and again after a case is settled.
 *
 * 🔴 IT READS `loadIntegrityBoard(viewer)` AND NEVER THE TABLE, exactly as the export beside it does, so
 * every narrowing the board applies applies here too — the position cases for the Super Admin alone,
 * the SFE Manager's allow-list, test captures for nobody but the Super Admin — and it refuses anybody
 * else with the board's own 404 (`phoenixCrmFailure` passes `notFoundError` through untouched), never
 * a 403 that names what it guards. Only the cases that still stand go out: the settled and withdrawn
 * ones are not the review's to decide.
 *
 * `canSettle` rides along so the review never offers a button the settle route would refuse.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const board = await loadIntegrityBoard(viewer);
    return NextResponse.json({ board: { cases: board.cases, canSettle: canSettleIntegrityCases(viewer), capped: board.capped }, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not read the cases.");
  }
}
