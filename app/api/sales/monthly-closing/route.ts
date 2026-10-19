import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { CLOSING_SCREEN_REUSE_MS } from "@/lib/sales/closing-load-gate";
import { loadMergedMonthlyClosingParts } from "@/lib/sales/monthly-closing-period-load";
import { parsePeriodSelection } from "@/lib/sales/monthly-closing-period-merge";
import { loadMonthlySourceCoverage } from "@/lib/sales/source-coverage";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);

    // View access mirrors the page (app/(admin)/sales/monthly-closing/page.tsx): Super Admin/system
    // AND SFE Manager. This route is that workspace's reload feed — the page already server-renders
    // this exact matrix for SFE Manager and his export already delivers the full workbook, so leaving
    // only this feed Super-Admin-only 403'd his Refresh / line change on screen (owner report,
    // 2026-08-10). Admitting him leaks no confidential data by construction: listMonthlyClosingLines
    // excludes the Head Office line for every viewer and the closing RPCs exclude the restricted
    // codes in SQL. Server-side enforcement — the sidebar link is UX only, never the boundary.
    // Publishing and locking stay Super-Admin-only in their own routes (publish|lock/route.ts).
    // The CEO appended 2026-09-07 alongside the page carve-out, and for the same reason the SFE
    // Manager was appended in 2026-08-10: the page server-renders this exact matrix for him, so
    // leaving this feed closed would 403 his Refresh and every Line / Month change on screen.
    // Publishing and locking stay Super-Admin-only in their own routes.
    if (access.role !== "Super Admin" && access.scope !== "system" && access.role !== "SFE Manager" && access.role !== "CEO") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Monthly Closing is restricted to the admin account." },
        { status: 403 },
      );
    }
    // sales:read for the CEO, sales:import for everyone else this route admits — mirroring the page
    // exactly. He must never hold the upload/publish key, and the role gate above is the boundary.
    await assertPermission(access, "sales", access.role === "CEO" ? "read" : "import");

    const { searchParams } = new URL(request.url);
    const line = searchParams.get("line");
    const period = searchParams.get("period");
    // `periods` is the multi-month form; `period` stays the single-month one every existing caller
    // already sends, and a selection of exactly one behaves identically to the way it always has.
    const selection = parsePeriodSelection(searchParams.get("periods"));
    // The Refresh button sends fresh=1 and always reads the database; a line or month change may
    // take a read that settled a few seconds ago, so a second tab opening the same closing does not
    // load it again (closing-load-gate.ts).
    const parts = await loadMergedMonthlyClosingParts({
      line,
      periods: selection.length > 0 ? selection : period ? [period] : [],
      reuseMs: searchParams.get("fresh") === "1" ? 0 : CLOSING_SCREEN_REUSE_MS,
    });
    const data = parts.combined;
    // Completeness ride-along: which of last month's sources are still absent from this month.
    // Degrades to null — the banner simply hides — rather than ever taking the closing down.
    //
    // Deliberately NOT read for a multi-month selection: the banner's whole sentence is "this month
    // is missing sources that fed the month before it", which has no meaning across a span and would
    // read as an authoritative claim about a month the reader never singled out.
    const coverage =
      (data.periods?.length ?? 0) > 1
        ? null
        : await loadMonthlySourceCoverage(data.line, data.period, access).catch(() => null);

    // `office` is the same grid holding only the Office channel's allocated units, so the workspace
    // can show "of which Office" beside every figure. Null (never an empty grid) when it could not
    // be read — the table then renders "—" and says so, rather than a misleading zero.
    //
    // `skipped` names any requested month the closing could not read, so the screen can say which
    // one is missing instead of quietly totalling fewer months than the reader asked for.
    return NextResponse.json({
      success: true,
      data,
      coverage,
      office: parts.office,
      periods: parts.periods,
      skipped: parts.skipped,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: clientSafeErrorMessage(error, "Failed to load Monthly Closing."),
      },
      { status: 500 },
    );
  }
}
