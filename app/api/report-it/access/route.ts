import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { reportItJsonError, reportItSignedOut } from "@/lib/report-it/http";
import { getDashboardAccessOverview, setDashboardAccess } from "@/lib/report-it/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who may read every safety report, and the log of every read and every change to that list.
 * Held by `report_it:export` — the Super Admin, the CEO and the Finance Manager (owner, 2026-11-13).
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.source === "guest" || !access.hrId) return reportItSignedOut();
    await assertPermission(access, "report_it", "export");
    return NextResponse.json(await getDashboardAccessOverview(access));
  } catch (error) {
    return reportItJsonError(error, "Failed to read the access list.");
  }
}

/** Body: { hrId: string, grant: boolean }. The change and its audit row are one transaction. */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    if (access.source === "guest" || !access.hrId) return reportItSignedOut();
    await assertPermission(access, "report_it", "export");

    const body = (await request.json().catch(() => ({}))) as { hrId?: unknown; grant?: unknown };
    if (typeof body.hrId !== "string" || typeof body.grant !== "boolean") {
      return NextResponse.json({ error: "Choose an employee and whether to give or remove access." }, { status: 400 });
    }
    const result = await setDashboardAccess(access, { hrId: body.hrId, grant: body.grant });
    return NextResponse.json({ ...result, ...(await getDashboardAccessOverview(access)) });
  } catch (error) {
    return reportItJsonError(error, "Failed to change access.");
  }
}
