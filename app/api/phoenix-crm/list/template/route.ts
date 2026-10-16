import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { afterResponse } from "@/lib/http/after-response";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { buildListTemplateFor } from "@/lib/phoenix-crm/server/list-template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// GET = the SFE's customer-list template for one territory (`?seatId=`). The territories themselves are
// read on the server by the page, so there is no second endpoint to keep in step with it.
//
// `approve`, the same gate as MOVING A PLACE — the module's other act reserved to the SFE Manager and
// the Super Admin — and narrowed again in the service by the integrity board's own predicate. NOT
// `update`: SFE holds `phoenix_crm: ["read", "approve"]` and no update, so an update gate would have
// made this the Super Admin's alone and quietly dropped the half of the owner's ask that names SFE.
// Audited as an export: a workbook naming a territory's customers and their grades leaves the building.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const seatId = search.get("seatId");

    const { buffer, fileName, seat } = await buildListTemplateFor(viewer, seatId, search.get("test"));
    // Written once the file has gone: `writeAuditLog` swallows its own failure, so the download never
    // depended on the insert and no longer waits for it.
    await afterResponse("phoenix_crm_list_template_audit", () =>
      writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: seat.seatId,
        entityType: "phoenix_crm_list_template",
        summary: `Downloaded the Phoenix CRM customer-list template for ${seat.seatId}`,
      }),
    );
    return new NextResponse(buffer as unknown as ArrayBuffer, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${fileName}"`,
        "content-type": XLSX,
      },
      status: 200,
    });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not build the list template.");
  }
}
