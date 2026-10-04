import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { DropTargetsRefusedError, dropMonthlyTargets } from "@/lib/sales/monthly-targets-drop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sales/targets/drop  (JSON) — { period, line }
// Drops every target of ONE line for ONE month. Super Admin only (owner, 2026-10-04): the role check
// below is the boundary, the button on the page is only UX. The rows are archived in
// au.monthly_targets_dropped before they are deleted, and a published or locked closing is refused.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    if (access.role !== "Super Admin") {
      return NextResponse.json({ success: false, error: "Only a Super Admin can drop a month's targets." }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as { period?: unknown; line?: unknown } | null;
    const period = String(body?.period ?? "").trim();
    const line = String(body?.line ?? "").trim();
    if (!period || !line) {
      return NextResponse.json({ success: false, error: "period and line are required." }, { status: 400 });
    }

    const { dropped, lineLabel } = await dropMonthlyTargets({
      period,
      line,
      actorHrId: access.hrId ?? access.loginId ?? null,
    });
    return NextResponse.json({ success: true, dropped, lineLabel });
  } catch (error) {
    if (error instanceof DropTargetsRefusedError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 409 });
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to drop targets.") }, { status: 500 });
  }
}
