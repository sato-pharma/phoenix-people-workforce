import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  computeSyncPeriods,
  getTerritorySyncStatus,
  syncTerritoryData,
  TERRITORY_SYNC_DEFAULT_MONTHS,
} from "@/lib/sales/territory/sync";

import { jsonError } from "../_lib/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// The Sync mutation re-stamps historical, already-reported Source-of-Sales rows across every batch
// they appear in and rebuilds the shared rollups the monthly closing also reads — a far bigger
// blast radius than a single mapping edit, so it is Super-Admin only. This is the same gate the
// historical reconciliation route uses (app/api/sales/mapping-database/customer-map/route.ts).
function assertSyncOperator(access: Awaited<ReturnType<typeof resolveAccessContext>>): void {
  if (access.role !== "Super Admin" && access.scope !== "system") {
    throw new Error("Forbidden: Territory data sync is restricted to the admin account.");
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

// POST — run the sync. Super-Admin only (see assertSyncOperator).
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    assertSyncOperator(access);

    const body = (await request.json().catch(() => ({}))) as { months?: unknown };
    const requestedMonths = Number(body?.months);
    const months = Number.isInteger(requestedMonths) && requestedMonths > 0
      ? requestedMonths
      : TERRITORY_SYNC_DEFAULT_MONTHS;
    const periods = computeSyncPeriods(months);

    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const report = await syncTerritoryData({ periods, actorLoginId });

    return NextResponse.json({
      success: true,
      message: report.restampedRows > 0
        ? `Synced: re-stamped ${report.restampedRows} row(s) to today's geography and rebuilt ${report.refreshedBatches} batch(es). ${report.allReconciled ? "All lines reconcile." : "Some lines did not reconcile — see the report."}`
        : `Already correct: nothing needed re-stamping. ${report.allReconciled ? "All lines reconcile." : "Some lines did not reconcile — see the report."}`,
      report,
    });
  } catch (error) {
    return jsonError(error, "Failed to sync territory data.");
  }
}
