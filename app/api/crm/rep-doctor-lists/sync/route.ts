import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { writeAuditLog } from "@/lib/admin/audit";
import { isIReports360Configured } from "@/lib/crm/config";
import { monthBounds, resolveRepDoctorListMonth } from "@/lib/crm/rep-doctor-lists";
import { assertRepDoctorListsAccess } from "@/lib/crm/rep-doctor-lists-access";
import { announceNewPlansToManagers } from "@/lib/crm/plan-notifications";
import { PlanSyncRangeError, syncIReports360WeeklyPlans } from "@/lib/crm/plan-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pulls one month of the CRM's weekly plan into Phoenix's mirror — the rep doctor lists.
//
// No longer the only trigger. Since 2026-08-27 the live poller refreshes the CURRENT month hourly
// in-process (src/lib/crm/live-poller.ts), which is what the owner asked for: a doctor added to or
// removed from a rep's list in the CRM shows up here without anyone pressing anything. This route
// stays for the two things a schedule cannot do — refreshing a month on demand, and reaching a
// month the scheduled window deliberately never touches. Every run is audited because it reaches an
// external system and rewrites a mirror; the audit row now also carries what was REMOVED.
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

    // A plan is "new" exactly once — the first run that mirrors it — so whichever trigger gets there
    // first owes the manager the notification. Without this, an admin pressing Refresh on the
    // current month would swallow the newness of every plan in it and the hourly poller, arriving
    // later, would correctly find nothing new to announce. Nobody would be told, and nothing would
    // look wrong.
    //
    // Restricted to the CURRENT Cairo month on purpose: this route is also how a HISTORICAL month is
    // pulled, and announcing there would email a manager about a plan for January. The 25-plan
    // ceiling inside `announceNewPlansToManagers` would stop a big backfill but not a small one.
    const isCurrentMonth = month === resolveRepDoctorListMonth(undefined);
    const announcement = isCurrentMonth
      ? await announceNewPlansToManagers(result.newPlans).catch(() => null)
      : null;

    await writeAuditLog({
      actorLoginId: access.loginId ?? access.hrId ?? null,
      entityType: "crm_plan_sync",
      entityId: month,
      newValues: result as unknown as Record<string, unknown>,
      summary:
        `Rep doctor lists refreshed for ${month} — ${result.upserted} planned calls across ` +
        `${result.agents} reps and ${result.contacts} contacts, ${result.pruned} removed` +
        (result.pruneRefusedReason ? ` (removal withheld: ${result.pruneRefusedReason})` : "") +
        (result.newPlans.length > 0
          ? `, ${result.newPlans.length} plan(s) seen for the first time` +
            (announcement
              ? ` (${announcement.announced} manager notification(s) sent` +
                (announcement.withheldReason ? `, withheld: ${announcement.withheldReason}` : "") +
                `)`
              : isCurrentMonth
                ? " (managers could not be notified)"
                : " (not announced — past month)")
          : ""),
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
