import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { adminDeleteRecord } from "@/lib/phoenix-crm/server/admin-delete";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Super Admin deletes a rep plan, a manager plan, a visit or a day record as if it never happened
// (owner, 2026-10-23). POST only: { kind, id, test }.
//
// `update`, the Super Admin's own permission here (the same gate as Settings and missed records), and
// narrowed AGAIN in the service to the Super Admin alone — `canEnterMissedRecords` — so holding `update`
// is not enough. The database keeps a copy of what it deletes.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as Record<string, unknown>;
    const deleted = await adminDeleteRecord(viewer, body);
    return NextResponse.json({ deleted, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not delete this record.");
  }
}
