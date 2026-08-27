import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
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
    if (access.role !== "Super Admin" && access.scope !== "system" && access.role !== "SFE Manager") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Monthly Closing is restricted to the admin account." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "import");

    const { searchParams } = new URL(request.url);
    const line = searchParams.get("line");
    const period = searchParams.get("period");
    // `periods` is the multi-month form; `period` stays the single-month one every existing caller
    // already sends, and a selection of exactly one behaves identically to the way it always has.
    const selection = parsePeriodSelection(searchParams.get("periods"));
    const parts = await loadMergedMonthlyClosingParts({
      line,
      periods: selection.length > 0 ? selection : period ? [period] : [],
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
        : await loadMonthlySourceCoverage(data.line, data.period).catch(() => null);

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
