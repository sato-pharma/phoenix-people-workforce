import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isValidVsTargetPeriod, loadBrickSales, rollupBricks } from "@/lib/sales/vs-target";
import { filterBricksForBound, resolveVsTargetBound } from "@/lib/sales/vs-target-scope";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sales/vs-target/bricks?period=&area=
// The brick grain behind one area row on the Sales vs Target dashboard.
//
// `area` is CALLER-SUPPLIED, so the viewer's bound is applied to the rows BEFORE the area
// filter, never after and never instead. A medical rep asking for a colleague's area gets
// an empty list because the self-bound already removed every row that is not theirs —
// the check cannot be forgotten because it is the same filter the page itself uses.
// Filtering by `area` first and trusting it would let anyone with sales:read enumerate the
// whole company's brick-level sales by editing the query string.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");

    const url = new URL(request.url);
    const period = (url.searchParams.get("period") ?? "").trim();
    const area = (url.searchParams.get("area") ?? "").trim().toUpperCase();

    if (!isValidVsTargetPeriod(period)) {
      return NextResponse.json(
        { success: false, error: "A period from July 2026 onwards is required." },
        { status: 400 },
      );
    }
    if (!area) {
      return NextResponse.json({ success: false, error: "An area is required." }, { status: 400 });
    }

    const bound = await resolveVsTargetBound(access);
    const scoped = filterBricksForBound(await loadBrickSales(period), bound);
    const forArea = scoped.filter((row) => String(row.areaCode ?? "").trim().toUpperCase() === area);

    return NextResponse.json({ success: true, bricks: rollupBricks(forArea, null) });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to load bricks.") },
      { status: 500 },
    );
  }
}
