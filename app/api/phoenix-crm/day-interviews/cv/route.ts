import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { afterResponse } from "@/lib/http/after-response";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { signedDayInterviewCvUrl } from "@/lib/phoenix-crm/server/interview-cvs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = open the CV of an interview added by hand to an Interviews day: a ten-minute signed link, for
// anyone who reads that territory. A booked interview's CV opens through the hiring calendar's own door.
// Audited like an export: a candidate's CV is a file that leaves the screen and is kept.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const id = search.get("id");
    const url = await signedDayInterviewCvUrl(viewer, { id, test: search.get("test") });
    await afterResponse("phoenix_crm_day_interview_cv_audit", () =>
      writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: id,
        entityType: "phoenix_crm_day_interview_cv",
        summary: "Opened the CV of an interview recorded on a Phoenix CRM Interviews day",
      }),
    );
    return NextResponse.redirect(url, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not open the CV.");
  }
}
