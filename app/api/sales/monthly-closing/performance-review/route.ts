import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { loadClosingPerformanceReview } from "@/lib/sales/closing-performance-review";
import { parseCodeList, parsePeriodSelection } from "@/lib/sales/monthly-closing-period-merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Performance Review for one line, one or several months, optionally narrowed — what the page
 * re-reads whenever the reader changes a picker or a filter. Same service the page's server render
 * used, so changing a control cannot produce a different shape of answer from loading the page
 * with those controls already set.
 *
 * The filter is applied HERE rather than in the browser, unlike the Monthly Closing screen's own:
 * the review is six views derived from the matrix, and narrowing after the derivation would leave
 * a rank of "3rd of 50" printed above a table showing four rows.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const url = new URL(request.url);
    const line = url.searchParams.get("line");
    const period = url.searchParams.get("period");
    const search = url.searchParams.get("search");

    // Every one of these is optional; a request sending none behaves exactly as this route always has.
    const data = await loadClosingPerformanceReview({
      filter: {
        areaCodes: parseCodeList(url.searchParams.get("areas")),
        productCodes: parseCodeList(url.searchParams.get("products")),
        regionCodes: parseCodeList(url.searchParams.get("regions")),
        search: search && search.trim() !== "" ? search : "",
      },
      line: line && line.trim() !== "" ? line : null,
      period: period && period.trim() !== "" ? period : null,
      periods: parsePeriodSelection(url.searchParams.get("periods")),
    });
    return Response.json({ data, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json({ error: "You do not have permission to view this report.", success: false }, { status: 403 });
    }
    return Response.json(
      { error: clientSafeErrorMessage(error, "Failed to load the Performance Review."), success: false },
      { status: 500 },
    );
  }
}
