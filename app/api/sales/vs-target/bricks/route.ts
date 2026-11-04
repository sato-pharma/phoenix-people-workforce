import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { foldAreaCodeForLine } from "@/lib/sales/closing-area-merges";
import {
  isRowPublished,
  isValidVsTargetPeriod,
  loadBrickSales,
  loadPublishedPeriodKeys,
  rollupBricks,
} from "@/lib/sales/vs-target";
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
    // PER ROW, BY THE ROW'S OWN LINE, as the dashboard above this panel gates its rows. An area code
    // repeats across lines (CA1 is CNS and Pedia), so in a month one line has published, a period-wide
    // check would hand over the bricks of the line that has not. A failed read throws to the 500 below.
    const [brickRows, publishedKeys] = await Promise.all([
      loadBrickSales(period),
      loadPublishedPeriodKeys(period, period),
    ]);
    const scoped = filterBricksForBound(brickRows, bound).filter((row) => isRowPublished(row, publishedKeys));

    // MATCH THE AREA THE PAGE SHOWS, WHICH IS THE FOLDED ONE.
    //
    // The Areas table applies `applyAchievementAreaMerges`, so on PEDIA the Beni Suef (UE9) row is
    // folded into Fayoum (GZ6) and the node the user clicks is keyed "GZ6" with a total that
    // INCLUDES Beni Suef. Comparing the raw `areaCode` here returned Fayoum's bricks only, so the
    // panel opened to prove the area number silently disproved it — a gap a DM cannot explain and
    // would reasonably read as sales missing from the pipeline.
    //
    // Measured on production 2026-09-05, through this route's own RPC:
    //   2026-07 Pedia  shown 29,913.38   missing  5,690.25  (16.0% of the area)
    //   2026-08 Pedia  shown  3,047.63   missing 11,100.38  (78.5%)
    // 16,790.63 EGP invisible. The audit filed this as latent because no Pedia row existed in UE9
    // yet; they exist now.
    //
    // FOLD PER ROW, BY THE ROW'S OWN LINE — not by expanding the requested code. PEDIA IS THE ONLY
    // MERGED LINE: the owner removed CNS on 2026-08-30 and it now shows the two areas separately.
    // A CNS or Anti Infective row in UE9 must NOT answer a request for GZ6, because those lines
    // show UE9 as its own area — pulling them in would corrupt the opposite drill-down and
    // re-merge a line he deliberately split. `foldAreaCodeForLine` reads the rule per line, so this
    // stays correct if the rule changes again; it also trims and upper-cases, matching `area` above.
    //
    // Safe with the bound, and the ORDER is what makes it safe: `filterBricksForBound` has already
    // dropped every row this viewer may not see, using the REAL area codes. Folding afterwards only
    // re-keys what survived, so a viewer scoped to Beni Suef alone still cannot pull in Fayoum's
    // bricks. Folding BEFORE the bound would hand them over — see the note above the handler.
    const forArea = scoped.filter((row) => foldAreaCodeForLine(row.lineCode, row.areaCode ?? "") === area);

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
