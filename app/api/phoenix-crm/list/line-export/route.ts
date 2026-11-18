import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { afterResponse } from "@/lib/http/after-response";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { buildLineCustomerList } from "@/lib/phoenix-crm/server/line-customer-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// GET = a whole line's customer list (`?line=`), grouped by region and then by rep (owner, 2026-11-18).
//
// `approve`, the list template's own gate — SFE holds `phoenix_crm: ["read", "approve"]` and no update —
// narrowed again in the service by the integrity board's predicate, so it is the SFE Manager's and the
// Super Admin's. Audited as an export: a workbook naming a line's customers and their grades leaves
// the building.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const { buffer, customers, fileName, lineName, territories } = await buildLineCustomerList(viewer, searchOf(request).get("line"));
    await afterResponse("phoenix_crm_line_customer_list_audit", () =>
      writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: lineName,
        entityType: "phoenix_crm_line_customer_list",
        summary: `Exported the ${lineName} line customer list (${territories} territories, ${customers} customers)`,
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
    return phoenixCrmFailure(error, "Could not build the line's customer list.");
  }
}
