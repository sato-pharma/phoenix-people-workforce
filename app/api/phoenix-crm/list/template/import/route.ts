import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { afterResponse } from "@/lib/http/after-response";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { importListTemplate } from "@/lib/phoenix-crm/server/list-template";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST = the filled template, as multipart form data: `file`, `seatId`, and `test` in test mode. The
// customers land on that territory's list as `pending`, for the rep to validate at the door — the place
// is captured there and can never come from a sheet (owner, 2026-09-23).
//
// The SFE Manager's and the Super Admin's, narrowed in the service by the integrity board's own
// predicate. Audited as a mutation: it writes a whole list at once, with the grades.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);

    const result = await importListTemplate(viewer, await request.formData());
    // Written once the answer has gone: `writeAuditLog` swallows its own failure, so the answer never
    // depended on the insert and no longer waits for it.
    await afterResponse("phoenix_crm_list_template_import_audit", () =>
      writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: result.seatId,
        entityType: "phoenix_crm_list_template_import",
        summary: `Loaded ${result.loaded} customer(s) onto the Phoenix CRM list for ${result.seatId} from a sheet (${result.refused.length} row(s) refused, days and hours set for ${result.hoursSet})`,
      }),
    );
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load that list.");
  }
}
