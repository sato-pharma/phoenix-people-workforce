import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadVisitReportCustomers } from "@/lib/phoenix-crm/server/visit-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the doctors, accounts and pharmacies of one rep's territory or one district (`?kind=rep|district&id=`), for
//       the Visit report's "Doctor or account" picker (owner, 2026-11-04: "filter by rep or area then filter by dr or
//       polyclinic"). Names only — the report's visits are read, and audited, by the report's own POST.
//
// 🔴 Behind the report's own door (`canReadVisitReport`) and its own 404s: a rep or a district outside the viewer's
// reach answers exactly as the report does.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const customers = await loadVisitReportCustomers(viewer, { id: search.get("id"), kind: search.get("kind") });
    return NextResponse.json({ customers, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not list the customers.");
  }
}
