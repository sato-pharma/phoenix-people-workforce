import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolveSyncablePeriods } from "@/lib/sales/territory/scheduled-sync";
import {
  getTerritorySyncStatus,
  syncTerritoryData,
  TERRITORY_SYNC_DEFAULT_MONTHS,
} from "@/lib/sales/territory/sync";

import { isTerritoryDrilldownRole, jsonError } from "../_lib/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// The Sync mutation re-stamps historical Source-of-Sales rows to today's geography and rebuilds the
// shared rollups the monthly closing also reads. It is corrective and idempotent (only rows whose
// brick actually moved are written; a second run re-stamps nothing), so — by owner decision — every
// role that can open the Territory Drilldown may run it, not only the admin account. Super Admin /
// system scope stay allowed too (that is the admin-console button's path).
function assertSyncOperator(access: Awaited<ReturnType<typeof resolveAccessContext>>): void {
  if (!isTerritoryDrilldownRole(access.role) && access.role !== "Super Admin" && access.scope !== "system") {
    throw new Error("Forbidden: Territory data sync is not available for your role.");
  }
}

// GET — read-only last-sync status for the drilldown's freshness badge. Any drilldown viewer may
// read it (it is just "when was this last synced, by whom"), so it only needs sales:read.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    const status = await getTerritorySyncStatus();
    return NextResponse.json({ success: true, status });
  } catch (error) {
    return jsonError(error, "Failed to load territory sync status.");
  }
}

// POST — run the sync. Open to every Territory Drilldown role (and admin); see assertSyncOperator.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    assertSyncOperator(access);

    const body = (await request.json().catch(() => ({}))) as { months?: unknown };
    const requestedMonths = Number(body?.months);
    const months = Number.isInteger(requestedMonths) && requestedMonths > 0
      ? requestedMonths
      : TERRITORY_SYNC_DEFAULT_MONTHS;

    // THE PUBLISHED-MONTH GUARD — the same one, from the same function, the nightly job uses. A
    // published closing has already been sent; its territories are never moved underneath it by a
    // button press. Withholding happens HERE and not in the database, because the DB trigger reads
    // `monthly_closing_locks` (a switch the owner toggles) while this reads
    // `monthly_closing_publications` (a permanent record) — an unlocked published month would sail
    // straight through the trigger.
    const { window, syncablePeriods, publishedPeriodsSkipped } = await resolveSyncablePeriods(months);
    const skippedNote = publishedPeriodsSkipped.length > 0
      ? ` Left untouched, because their closing is published: ${publishedPeriodsSkipped.join(", ")}.`
      : "";

    // Never call the RPC with an empty list: `phx_sync_sos_run` treats an absent period list as
    // EVERY period, so an empty array would re-stamp precisely the published months this guard
    // exists to protect.
    if (syncablePeriods.length === 0) {
      return NextResponse.json({
        success: true,
        message: `Nothing to sync — every month in the window has a published closing, and a published month is never re-stamped.${skippedNote}`,
        report: null,
        window,
        syncedPeriods: [],
        publishedPeriodsSkipped,
      });
    }

    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const report = await syncTerritoryData({ periods: syncablePeriods, actorLoginId });

    return NextResponse.json({
      success: true,
      message: report.restampedRows > 0
        ? `Synced: re-stamped ${report.restampedRows} row(s) to today's geography and rebuilt ${report.refreshedBatches} batch(es). ${report.allReconciled ? "All lines reconcile." : "Some lines did not reconcile — see the report."}${skippedNote}`
        : `Already correct: nothing needed re-stamping. ${report.allReconciled ? "All lines reconcile." : "Some lines did not reconcile — see the report."}${skippedNote}`,
      report,
      window,
      syncedPeriods: syncablePeriods,
      publishedPeriodsSkipped,
    });
  } catch (error) {
    return jsonError(error, "Failed to sync territory data.");
  }
}
