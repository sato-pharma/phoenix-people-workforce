import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { getTerritoryAreaPharmacies } from "@/lib/sales/territory/service";
import { TERRITORY_DEFAULT_WINDOW_MONTHS, TERRITORY_MAX_WINDOW_MONTHS } from "@/lib/sales/territory/window";

import { isTerritoryDrilldownRole, jsonError } from "../../_lib/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const months = Number.isInteger(monthsParam) && monthsParam > 0 && monthsParam <= TERRITORY_MAX_WINDOW_MONTHS
      ? monthsParam
      : TERRITORY_DEFAULT_WINDOW_MONTHS;

    // Super Admin / CEO drill a line they pick; every other role's line is derived and this is
    // ignored. The client echoes the skeleton's officialLine so the fetch stays on the same line.
    const selectedLine = searchParams.get("line");
    // The window ends at the drilled line's newest published closing (resolved by the service), so
    // the months returned here are the months the page labelled — never the open month.
    const payload = await getTerritoryAreaPharmacies(access, decodeURIComponent(areaCode), months, selectedLine);
    return NextResponse.json({ success: true, ...payload });
  } catch (error) {
    return jsonError(error, "Failed to load area pharmacies.");
  }
}
