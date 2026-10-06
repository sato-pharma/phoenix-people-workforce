import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadVisitEditForm, saveVisitEdit } from "@/lib/phoenix-crm/server/visit-edit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Super Admin CORRECTS a visit a rep submitted (owner, 2026-10-06: "make the admin able to edit a
// visit submitted by an employee. Example, if he chooses a wrong double visit, make me able to enter and
// edit it") — who was on it, its products and its comment, and nothing else.
//
// GET  = the visit as it stands, and who the picker offers for its territory.
// POST = save the correction. The database keeps what the visit said before.
//
// `update`, the Super Admin's own permission here (the same gate as Settings and "a record a rep
// missed"), and narrowed AGAIN in the service to the Super Admin alone — `territoryForVisitEdit` — so
// holding `update` is not enough.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const form = await loadVisitEditForm(viewer, {
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
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as Record<string, unknown>;
    const saved = await saveVisitEdit(viewer, body);
    return NextResponse.json({ saved, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save this correction.");
  }
}
