import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import {
  loadClosingPerformanceReview,
  PERFORMANCE_REVIEW_MONTHS,
} from "@/lib/sales/closing-performance-review";
import { buildClosingPerformanceReviewWorkbook } from "@/lib/sales/closing-performance-review-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Slug for one filename segment: lowercase, hyphenated, never empty. */
function slug(value: string | null | undefined): string {
  return (
    (value ?? "all")
      .toString()
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "all"
  );
}

/**
 * The Performance Review workbook — the file behind the page's own Export button.
 *
 * It rebuilds the review from the SAME service the page rendered from, at the same (line, period),
 * so the file and the screen cannot show different numbers. Nothing about the sheet is passed in
 * from the browser except which month and line to read.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:closing-performance-review",
    });

    const body = (await request.json().catch(() => ({}))) as {
      line?: string | null;
      months?: number;
      period?: string | null;
    };

    const review = await loadClosingPerformanceReview({
      line: typeof body.line === "string" && body.line.trim() !== "" ? body.line : null,
      months: Number.isFinite(body.months) ? Number(body.months) : PERFORMANCE_REVIEW_MONTHS,
      period: typeof body.period === "string" && body.period.trim() !== "" ? body.period : null,
    });

    const buffer = await buildClosingPerformanceReviewWorkbook(review);
    const fileName = `sato-performance-review-${slug(review.period)}-${slug(review.line)}.xlsx`;
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json({ error: "You do not have permission to export this report." }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    return Response.json({ error: clientSafeErrorMessage(error, "Export failed.") }, { status: 500 });
  }
}
