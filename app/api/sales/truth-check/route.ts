import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { loadSalesTruthReport } from "@/lib/sales/sales-truth-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Three closings plus the achievement range for a whole month. Slower than a page load, and it is
// meant to be — this is the check that reads everything rather than sampling it.
export const maxDuration = 120;

/**
 * Does every sales surface print the same number for the same area?
 *
 * Read-only, and reachable by a cron or an uptime check as well as the page: it answers
 * `{ ok: false }` with the offending areas rather than an error status, so a monitor can watch the
 * FIELD and a human can read the list. Monthly Closing is the truth; everything else is measured
 * against it.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // Same gate as the sibling closing tools. This exposes per-area company sales for every line.
    await assertPermission(access, "sales", "read");

    const period = new URL(request.url).searchParams.get("period");
    const report = await loadSalesTruthReport(period && /^\d{4}-\d{2}$/.test(period) ? period : null);
    return NextResponse.json({ success: true, data: report });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "The sales truth check failed to run.") },
      { status: 500 },
    );
  }
}
