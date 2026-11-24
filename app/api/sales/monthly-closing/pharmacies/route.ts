import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { loadAdminClosingPharmacyCounts, pharmacyCountsForScreen } from "@/lib/sales/closing-pharmacy-counts-loader";
import { parsePeriodSelection } from "@/lib/sales/monthly-closing-period-merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The Pharmacies column of the admin Closing Matrix (owner, 24 Nov 2026: "add the pharmacy count
// inside the monthly closing sales sheet"). Read beside the matrix, never inside its load, so a slow
// count can never hold the closing up — the column reads "—" until it lands.
//
// THE SAME GATE AS THE MATRIX IT SITS IN (app/api/sales/monthly-closing/route.ts), term for term:
// Super Admin / system, SFE Manager and the CEO; sales:read for the CEO, sales:import otherwise.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system" && access.role !== "SFE Manager" && access.role !== "CEO") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Monthly Closing is restricted to the admin account." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", access.role === "CEO" ? "read" : "import");

    const { searchParams } = new URL(request.url);
    const line = searchParams.get("line")?.trim() ?? "";
    const period = searchParams.get("period")?.trim() ?? "";
    const selection = parsePeriodSelection(searchParams.get("periods"));
    const result = await loadAdminClosingPharmacyCounts({
      access,
      line,
      periods: selection.length > 0 ? selection : period ? [period] : [],
      fresh: searchParams.get("fresh") === "1",
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.message }, { status: result.status });
    }
    return NextResponse.json({ success: true, data: pharmacyCountsForScreen(result.counts) });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to count the pharmacies.") },
      { status: 500 },
    );
  }
}
