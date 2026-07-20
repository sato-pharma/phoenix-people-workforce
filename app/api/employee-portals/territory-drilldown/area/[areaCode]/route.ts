import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { shiftPeriod } from "@/lib/sales/periods";
import { getTerritoryAreaPharmacies } from "@/lib/sales/territory/service";

import { isTerritoryDrilldownRole, jsonError } from "../../_lib/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_MONTHS_BACK = 6;
const MAX_MONTHS_BACK = 12;

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Every period in the trailing window, oldest first, so a pharmacy's monthly presence can be
 *  computed even for months it had zero sales (not just the months it has a row for). */
function lastNPeriods(n: number): string[] {
  const periods: string[] = [];
  for (let monthsBack = n - 1; monthsBack >= 0; monthsBack--) {
    const period = shiftPeriod(currentPeriod(), monthsBack);
    if (period) periods.push(period);
  }
  return periods;
}

// The lazy per-area pharmacy fetch — fired only when a user expands an Area lane, never on
// initial page load. The server re-derives the caller's territory scope on THIS request too
// (see getTerritoryAreaPharmacies) and 403s if the requested area falls outside it, so the
// boundary holds even if a client tampers with the URL.
export async function GET(request: Request, context: { params: Promise<{ areaCode: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    if (!isTerritoryDrilldownRole(access.role)) {
      return NextResponse.json(
        { success: false, error: "forbidden", message: "This role doesn't have a territory drilldown yet." },
        { status: 403 },
      );
    }

    const { areaCode } = await context.params;
    const { searchParams } = new URL(request.url);
    const monthsParam = Number(searchParams.get("months"));
    const monthsBack = Number.isInteger(monthsParam) && monthsParam > 0 && monthsParam <= MAX_MONTHS_BACK
      ? monthsParam
      : DEFAULT_MONTHS_BACK;
    const periods = lastNPeriods(monthsBack);

    const payload = await getTerritoryAreaPharmacies(access, decodeURIComponent(areaCode), periods);
    return NextResponse.json({ success: true, periods, ...payload });
  } catch (error) {
    return jsonError(error, "Failed to load area pharmacies.");
  }
}
