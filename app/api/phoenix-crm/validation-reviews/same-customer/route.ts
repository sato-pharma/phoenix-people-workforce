import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadCustomerMatchBoard } from "@/lib/phoenix-crm/server/customer-match-groups";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the fourth tab of Place checks: one customer validated by two or more reps at places that do not
// agree (owner, 2026-10-26). Read when the tab is OPENED, never with the page. The Super Admin and the SFE
// Manager: `read` here is gate one and the loader refuses everyone else before a row is read.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const { board, capped } = await loadCustomerMatchBoard(viewer);
    return NextResponse.json({ board: { ...board, capped }, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the customers several reps validated.");
  }
}
