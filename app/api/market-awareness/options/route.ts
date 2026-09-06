import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { marketAwarenessErrorResponse } from "@/lib/market-awareness/api-response";
import { assertPermission } from "@/lib/auth/permissions";
import { loadBricksForArea, loadRegionsForLine } from "@/lib/market-awareness/geography";
import { loadMarketAwarenessLines } from "@/lib/market-awareness/lines";
import { loadActivityProducts } from "@/lib/market-awareness/products";
import { loadActivityTypes } from "@/lib/market-awareness/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the request form needs, in one call. The cascade is driven by query parameters so a
 * region change costs one request rather than a page load:
 *
 *   (none)          activity types and the tracked lines
 *   ?lineCode=cns   the regions and areas of that line, plus its trackable products
 *   ?areaCode=AB1   the bricks of that area
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "market_awareness", "read");

    const params = new URL(request.url).searchParams;
    const lineCode = params.get("lineCode");
    const areaCode = params.get("areaCode");

    if (areaCode) {
      return NextResponse.json(
        { bricks: await loadBricksForArea(areaCode), success: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (lineCode) {
      const [regions, products] = await Promise.all([
        loadRegionsForLine(lineCode),
        loadActivityProducts(lineCode),
      ]);
      return NextResponse.json(
        { products, regions, success: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const [activityTypes, lines] = await Promise.all([loadActivityTypes(), loadMarketAwarenessLines()]);
    return NextResponse.json(
      { activityTypes, lines, success: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return marketAwarenessErrorResponse(error, "Could not load the form options.");
  }
}
