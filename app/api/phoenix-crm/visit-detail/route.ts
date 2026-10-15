import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadVisitDetailForm, saveVisitDetail } from "@/lib/phoenix-crm/server/visit-detail-edit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The REP fills in his OWN saved visit's detail (owner, 2026-10-15: "they may not have suitable time to
// do the full report needed by the company in between the visits … they can go to the visit, press on
// it, have those things editable") — the detailed comment, the objection, the next step, what he left,
// the pharmacy stock answers, and a pharmacy name the visit does not yet carry.
//
// GET  = the visit's detail as it stands, plus his line's products.
// POST = save it. The database keeps what each of the six things said before.
//
// `read` and `create` are the rep's OWN permissions — he holds no `update`, which is the Super Admin's
// separate correction door (`/api/phoenix-crm/visit-edit`). Narrowed again in the service by
// `territoryForRepWrite`, which admits the territory's own rep and refuses the Super Admin by name, so
// holding `create` is not enough.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const form = await loadVisitDetailForm(viewer, {
      seatId: search.get("seatId"),
      test: search.get("test"),
      visitId: search.get("visitId"),
    });
    return NextResponse.json({ form, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load this visit.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as Record<string, unknown>;
    const saved = await saveVisitDetail(viewer, body);
    return NextResponse.json({ saved, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the detail.");
  }
}
