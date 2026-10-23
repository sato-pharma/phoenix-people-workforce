/**
 * GET /api/admin/field-activity/report?hrId=&from=&to= — one person's field activity.
 *
 * THE SCOPE CHECK IS HERE, not on the page. `system-navigation.ts` hiding a link is UX; a viewer
 * who types the hr id of somebody outside his team is refused by `canOpenSubject`, which applies the
 * same org-tree scope the picker was built from. A refusal says "forbidden" and nothing else — it
 * never reveals whether that person exists.
 */

import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canOpenSubject, resolveFieldActivityAccess } from "@/lib/field-activity/access";
import { resolvePeriod } from "@/lib/field-activity/period";
import { phoenixDetailViewer } from "@/lib/crm/phoenix-visit-detail";
import { loadFieldActivityReport } from "@/lib/field-activity/report";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // The coarse gate, stated where a reviewer looks for it. `resolveFieldActivityAccess` checks
    // the same grant itself and then narrows to the viewer's org-tree scope — but server-side
    // access control is THE security boundary in this repo, and a boundary a route handler does
    // not name is one the next edit can quietly move.
    await assertPermission(access, "double_visit_analytics", "read");
    const resolved = await resolveFieldActivityAccess(access);
    if (!resolved) {
      return NextResponse.json({ error: "forbidden", success: false }, { status: 403 });
    }

    const url = new URL(request.url);
    const subjectHrId = (url.searchParams.get("hrId") ?? "").trim();
    if (!subjectHrId) {
      return NextResponse.json({ error: "hr_id_required", message: "Pick a person first.", success: false }, { status: 400 });
    }
    if (!canOpenSubject(resolved, subjectHrId)) {
      return NextResponse.json({ error: "forbidden", success: false }, { status: 403 });
    }

    const period = resolvePeriod(url.searchParams.get("from"), url.searchParams.get("to"));
    if (!period.ok) {
      return NextResponse.json({ error: "bad_period", message: period.reason, success: false }, { status: 400 });
    }

    const report = await loadFieldActivityReport({
      fromIso: period.fromIso,
      panels: resolved.panels,
      subjectHrId,
      toIso: period.toIso,
      // WHO IS READING. The Phoenix field set is on this report because the owner asked for it
      // (2026-10-07, "everything, GPS and evidence included"); which half each reader sees is his own
      // 2026-10-02 ruling, and a reader opening the day of a rep who is himself reads none of it.
      viewer: phoenixDetailViewer(resolved.role, resolved.viewerHrId),
    });
    if (!report) {
      return NextResponse.json({ error: "not_found", message: "No employee record for that person.", success: false }, { status: 404 });
    }

    return NextResponse.json({ data: { panels: resolved.panels, report }, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", success: false }, { status: 403 });
    }
    return NextResponse.json(
      { error: "field_activity_report_failed", message: clientSafeErrorMessage(error, "Unknown error"), success: false },
      { status: 500 },
    );
  }
}
