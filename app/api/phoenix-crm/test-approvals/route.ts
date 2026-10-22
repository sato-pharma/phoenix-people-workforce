import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { loadTestApprovals } from "@/lib/phoenix-crm/server/test-approvals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = every approval the test personas sent, at the step it is at (owner, 2026-10-22). The Super
// Admin's alone, signed in as himself — the service asks `assertTestWorldDecider` before it reads.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const testApprovals = await loadTestApprovals(viewer);
    return NextResponse.json({ testApprovals, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the test approvals.");
  }
}
