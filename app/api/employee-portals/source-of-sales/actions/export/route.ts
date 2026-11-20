import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { closingDetailDistributorName, loadDistributorNameIndex } from "@/lib/sales/closing-details-distributor-names";
import { loadAreaSeatAssignments } from "@/lib/sales/closing-performance-review";
import { canReadPharmacyActions } from "@/lib/sales/portal-sos-dashboard";
import { loadPortalPharmacyActions } from "@/lib/sales/sos-pharmacy-actions-loader";
import {
  buildPharmacyActionsWorkbook,
  pharmacyActionsFileName,
  seatLineKey,
  type AreaPeople,
} from "@/lib/sales/sos-pharmacy-actions-workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The sheet download behind "Where my sales come from": every pharmacy that stopped, dropped or
// started buying, with its month-by-month history, its area, brick and the rep who covers it today.
// Scope is resolved from the SESSION exactly as the screen's feed resolves it — the same loader, built
// uncapped — so the sheet can never hold a pharmacy the screen would not show. Query: `line` (the
// viewer's pick, refused outside his scope), `period` (a published closing to read as of) and `area`
// (one area code, the screen's area pick).

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    if (!canReadPharmacyActions(access.role)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const requestedLine = searchParams.get("line")?.trim() || null;
    const endPeriod = searchParams.get("period")?.trim() || null;
    const areaCode = searchParams.get("area")?.trim().toUpperCase() || null;

    const [data, seats, distributorNames] = await Promise.all([
      loadPortalPharmacyActions({ access, requestedLine, endPeriod, forExport: true }),
      loadAreaSeatAssignments(),
      loadDistributorNameIndex(),
    ]);
    if (!data.actions) {
      return NextResponse.json({ success: false, error: data.message ?? "No published closing to read yet." }, { status: 404 });
    }

    // Today's holder of each area's rep seat on this line — the person to send now, not last month's.
    const peopleByArea = new Map<string, AreaPeople>();
    const prefix = `${seatLineKey(data.line)}::`;
    for (const [key, seat] of seats) {
      if (!key.startsWith(prefix)) continue;
      peopleByArea.set(key.slice(prefix.length), {
        repName: seat.repIsVacant ? null : seat.repName,
        managerName: seat.managerName,
      });
    }

    // An area outside the result is simply nothing to list — never a widening back to every area.
    const pickedArea = areaCode && data.actions.byArea[areaCode] ? areaCode : null;
    if (areaCode && !pickedArea) {
      return NextResponse.json({ success: false, error: "That area has nothing in your scope." }, { status: 404 });
    }

    const buffer = await buildPharmacyActionsWorkbook({
      line: data.line,
      actions: data.actions,
      peopleByArea,
      areaCode: pickedArea,
      // The closing's own naming rule: a masked distributor (El Qema) is blank unless the viewer may see it.
      distributorNameOf: (code) => closingDetailDistributorName(code, distributorNames, access),
    });
    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${pharmacyActionsFileName(data.line, data.actions.latestPeriod)}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Could not build the pharmacy sheet.") },
      { status: 500 },
    );
  }
}
