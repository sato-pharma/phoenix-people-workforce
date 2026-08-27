import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { loadClosingPerformanceReview } from "@/lib/sales/closing-performance-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Performance Review for one (line, period) — what the page re-reads when the reader changes
 * either picker. Same service the page's server render used, so switching month cannot produce a
 * different shape of answer from loading the page at that month directly.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const url = new URL(request.url);
    const line = url.searchParams.get("line");
    const period = url.searchParams.get("period");

    const data = await loadClosingPerformanceReview({
      line: line && line.trim() !== "" ? line : null,
      period: period && period.trim() !== "" ? period : null,
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
