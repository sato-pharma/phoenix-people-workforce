import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { addDaysIso, todayIso } from "@/lib/crm/dates";
import { syncIReports360Visits } from "@/lib/crm/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Manual "sync now" from the CRM hub. The daily cron already re-pulls a 10-day window ~3x/day,
// so a manual pull only needs to catch the very latest CRM edits — a short recent window keeps
// each call well within the function duration limit.
const MANUAL_SYNC_LOOKBACK_DAYS = 7;

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin") {
      return NextResponse.json(
        { error: "forbidden", message: "Only Super Admin can trigger a CRM sync.", success: false },
        { status: 403 },
      );
    }

    const dateTo = todayIso();
    const dateFrom = addDaysIso(dateTo, -MANUAL_SYNC_LOOKBACK_DAYS);
    const result = await syncIReports360Visits({ dateFrom, dateTo, trigger: "manual" });
    return NextResponse.json({ dateFrom, dateTo, success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CRM sync failed.";
    return NextResponse.json({ error: "crm_sync_failed", message, success: false }, { status: 500 });
  }
}
