import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { loadVisitReport } from "@/lib/phoenix-crm/server/visit-report";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A quarter of one rep, or a month of a district, with several side tables read per chosen category.
export const maxDuration = 60;

// POST = the Visit report generator's answer for one rep or district, one period and the chosen fields
//        (owner, 2026-10-15): the visits, the dashboard figures and the map's points. A READ sent as a POST,
//        because the chosen fields do not belong in a URL, and audited as a read: it discloses where
//        named people's phones were.
//
// 🔴 The Super Admin and the SFE Manager (the company) and a district manager (his own team) — narrowed in the service (`canReadVisitReport`), which
// answers anybody else with a 404 so the report's existence is not confirmed. The SFE Manager's answer
// never holds the mock-location evidence: the loader does not read it for him.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as Record<string, unknown>;
    const view = await loadVisitReport(viewer, {
      fields: body.fields,
      from: body.from,
      id: body.id,
      kind: body.kind,
      to: body.to,
    });
    return NextResponse.json({ success: true, view });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not build the visit report.");
  }
}
