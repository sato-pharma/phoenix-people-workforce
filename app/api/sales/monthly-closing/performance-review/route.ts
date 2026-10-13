import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { loadClosingPerformanceReview } from "@/lib/sales/closing-performance-review";
import {
  canOpenClosingPerformanceReview,
  canOpenPortalClosingPerformanceReview,
  CLOSING_PERFORMANCE_REVIEW_AUDIENCE_MESSAGE,
  performanceReviewSalesAction,
} from "@/lib/sales/closing-performance-review-access";
import { loadScopedClosingPerformanceReview } from "@/lib/sales/closing-performance-review-portal";
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
 *
 * Same audience as the page, asked through the same functions. `sales:import` alone names the same
 * roles today, but only because of how the matrix happens to read — one override granting it
 * to another role would open the company-wide review to that role here, and nowhere else.
 *
 * TWO AUDIENCES, AND THE UNBOUNDED ONE IS ASKED FIRST. The admin audience gets exactly what this
 * route always returned. A sales manager (owner, 2026-10-13) gets the SCOPED read instead — his own
 * areas, his own published months — resolved from HIS OWN access here on the server, so the
 * narrowing cannot be widened by anything the browser sends: a `?line=` outside his scope is
 * refused rather than substituted, and a `?period=` he may not read is named, not quietly dropped.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const isAdminAudience = canOpenClosingPerformanceReview(access);
    if (!isAdminAudience && !canOpenPortalClosingPerformanceReview(access)) {
      return Response.json({ error: CLOSING_PERFORMANCE_REVIEW_AUDIENCE_MESSAGE, success: false }, { status: 403 });
    }
    // `import` for the admin audience, `read` for a portal manager — who does not hold `import`, so
    // asserting it here 403'd every month change and every filter for the audience this was built for.
    await assertPermission(access, "sales", performanceReviewSalesAction(isAdminAudience));

    const url = new URL(request.url);
    const line = url.searchParams.get("line");
    const period = url.searchParams.get("period");
    const search = url.searchParams.get("search");
    const filter = {
      areaCodes: parseCodeList(url.searchParams.get("areas")),
      productCodes: parseCodeList(url.searchParams.get("products")),
      regionCodes: parseCodeList(url.searchParams.get("regions")),
      search: search && search.trim() !== "" ? search : "",
    };

    if (!isAdminAudience) {
      const scoped = await loadScopedClosingPerformanceReview({
        access,
        filter,
        requestedLine: line,
        requestedPeriod: period,
        requestedPeriods: parsePeriodSelection(url.searchParams.get("periods")),
      });
      if (scoped.refusedLine) {
        return Response.json(
          { error: "That product line is outside your scope.", success: false },
          { status: 403 },
        );
      }
      if (!scoped.review) {
        return Response.json(
          {
            error: scoped.awaitingPublish
              ? "No month has been published for your line yet."
              : "There is no closing in your scope to review yet.",
            success: false,
          },
          { status: 404 },
        );
      }
      return Response.json({ data: scoped.review, success: true });
    }

    // Every one of these is optional; a request sending none behaves exactly as this route always has.
    const data = await loadClosingPerformanceReview({
      filter,
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
