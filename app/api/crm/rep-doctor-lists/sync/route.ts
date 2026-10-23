import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { writeAuditLog } from "@/lib/admin/audit";
import { cairoTodayIso } from "@/lib/crm/dates";
import { isIReports360Configured } from "@/lib/crm/config";
import { resolveVendorSyncStandDown, VENDOR_SYNC_RETIRED_MESSAGE } from "@/lib/crm/cutover";
import { monthBounds, resolveRepDoctorListMonth } from "@/lib/crm/rep-doctor-lists";
import { assertRepDoctorListsAccess } from "@/lib/crm/rep-doctor-lists-access";
import { announceNewPlansToManagers } from "@/lib/crm/plan-notifications";
import { PlanSyncRangeError, resolvePlanSyncWindow, syncIReports360WeeklyPlans } from "@/lib/crm/plan-sync";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pulls the CRM's weekly plan into Phoenix's mirror — the rep doctor lists.
//
// No longer the only trigger. Since 2026-08-27 the live poller refreshes the CURRENT month hourly
// in-process (src/lib/crm/live-poller.ts), which is what the owner asked for: a doctor added to or
// removed from a rep's list in the CRM shows up here without anyone pressing anything. This route
// stays for the two things a schedule cannot do — refreshing on demand, and reaching a month the
// scheduled window deliberately never touches. Every run is audited because it reaches an external
// system and rewrites a mirror; the audit row now also carries what was REMOVED.
//
// "One month" is no longer quite the unit, and the difference matters: for the CURRENT month this
// route delegates to `resolvePlanSyncWindow`, which reaches past the month's end so next week's
// plans are fetched before the week starts. A HISTORICAL month is still strictly its own bounds.
//
// Gated twice: the Super-Admin-only role list (rep-doctor-lists-access.ts, the owner's
// "admin account only for now") and the crm_visits:update permission, which is the real boundary.

/** The scheduled sync's own window, in this route's `{ from, to }` shape — so the manual refresh and
 * the hourly poller can never drift apart on what "the current month" means. */
function monthBoundsOfScheduledWindow(): { from: string; to: string } {
  const window = resolvePlanSyncWindow(cairoTodayIso());
  return { from: window.startDate, to: window.endDate };
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertRepDoctorListsAccess(access);
    await assertPermission(access, "crm_visits", "update");

    // THE CRM CUTOVER. This pulls plans from iReports360; once it is retired, plans are filed in
    // Phoenix and already on the board.
    const standDown = await resolveVendorSyncStandDown();
    if (standDown) {
      return NextResponse.json({ error: VENDOR_SYNC_RETIRED_MESSAGE }, { status: 409 });
    }

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
    const isCurrentMonth = month === resolveRepDoctorListMonth(undefined);

    // THE CURRENT MONTH IS FETCHED THROUGH THE SCHEDULED WINDOW, NOT THROUGH `monthBounds`, and the
    // two are no longer the same thing: since 2026-09-02 the scheduled window reaches
    // PLAN_SYNC_FORWARD_MARGIN_DAYS past the month's end so that next week's plans exist before the
    // week does. Pressing Refresh must not fetch LESS than the schedule already fetches — a manager
    // who presses it to see next week's plan and gets the bare month back would read the empty
    // result as "he has not filed one", which is the exact confusion this margin was added to end.
    //
    // A HISTORICAL month keeps the strict `monthBounds`, and that asymmetry is the point: a wide
    // window over a closed month hands the prune rows it must never be allowed to delete (the
    // owner's 2026-08-27 ruling — see resolvePlanSyncWindow).
    const { from, to } = isCurrentMonth ? monthBoundsOfScheduledWindow() : monthBounds(month);

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
    if (isForbiddenError(error)) return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ error: String((error as { message?: unknown })?.message ?? error) }, { status: 500 });
  }
}
