import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { afterResponse } from "@/lib/http/after-response";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { deleteVisitReportView, listVisitReportViews, saveVisitReportView } from "@/lib/phoenix-crm/server/visit-report-views";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Visit report's saved views (owner, 2026-10-16): a reader's own named choices of fields.
//
// GET    = the viewer's own views, each cleaned to the viewer's sight.
// POST   = save the ticked fields under a name; the same name again replaces that view.
// DELETE = remove one of the viewer's own views (`?id=`).
//
// 🔴 ONLY ITS OWNER — the service keys every call on the viewer's own HR id and takes no owner argument,
// and it answers anybody the report itself refuses (`canReadVisitReport`) with the same 404. A save and a
// delete are recorded past the response, so a logging failure never refuses the reader.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    return NextResponse.json({ success: true, views: await listVisitReportViews(viewer) });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not read your saved views.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const view = await saveVisitReportView(viewer, { fields: body.fields, name: body.name });
    await afterResponse("phoenix_crm_visit_report_saved_view_audit", () =>
      writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: view.id,
        entityType: "phoenix_crm_visit_report_saved_view",
        summary: `Saved the Visit report view "${view.name}" (${view.fields.length} fields)`,
      }),
    );
    return NextResponse.json({ success: true, view });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the view.");
  }
}

export async function DELETE(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const deleted = await deleteVisitReportView(viewer, searchOf(request).get("id"));
    await afterResponse("phoenix_crm_visit_report_saved_view_audit", () =>
      writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: deleted.id,
        entityType: "phoenix_crm_visit_report_saved_view",
        summary: `Deleted the Visit report view "${deleted.name}"`,
      }),
    );
    return NextResponse.json({ deleted: true, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not delete the view.");
  }
}
