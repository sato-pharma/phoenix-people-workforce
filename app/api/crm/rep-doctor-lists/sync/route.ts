import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { writeAuditLog } from "@/lib/admin/audit";
import { isIReports360Configured } from "@/lib/crm/config";
import { monthBounds, resolveRepDoctorListMonth } from "@/lib/crm/rep-doctor-lists";
import { assertRepDoctorListsAccess } from "@/lib/crm/rep-doctor-lists-access";
import { PlanSyncRangeError, syncIReports360WeeklyPlans } from "@/lib/crm/plan-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pulls one month of the CRM's weekly plan into Phoenix's mirror — the rep doctor lists.
//
// On-demand only, by design. There is no cron for this: the plan is a slow-moving assignment list,
// not a daily event stream, and the platform's one scheduled CRM job feeds payroll attendance —
// adding a second failure mode inside it to refresh a report would be a bad trade. An admin
// presses Refresh; the run is audited because it reaches an external system and rewrites a mirror.
//
// Gated twice: the Super-Admin-only role list (rep-doctor-lists-access.ts, the owner's
// "admin account only for now") and the crm_visits:update permission, which is the real boundary.

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertRepDoctorListsAccess(access);
    await assertPermission(access, "crm_visits", "update");

    if (!isIReports360Configured()) {
      return NextResponse.json(
        { error: "The iReports360 connection is not configured in this environment." },
        { status: 503 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { month?: unknown };
    // An unparseable month resolves to the current one rather than 400-ing: the only caller is the
    // board's own Refresh button, which always sends the month it is displaying.
    const month = resolveRepDoctorListMonth(typeof body?.month === "string" ? body.month : undefined);
    const { from, to } = monthBounds(month);

    const result = await syncIReports360WeeklyPlans({ endDate: to, startDate: from });

    await writeAuditLog({
      actorLoginId: access.loginId ?? access.hrId ?? null,
      entityType: "crm_plan_sync",
      entityId: month,
      newValues: result as unknown as Record<string, unknown>,
      summary:
        `Rep doctor lists refreshed for ${month} — ${result.upserted} planned calls across ` +
        `${result.agents} reps and ${result.contacts} contacts`,
    });

    return NextResponse.json({ month, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlanSyncRangeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (isForbiddenError(error)) return NextResponse.json({ error: String(error) }, { status: 403 });
    return NextResponse.json({ error: String((error as { message?: unknown })?.message ?? error) }, { status: 500 });
  }
}
