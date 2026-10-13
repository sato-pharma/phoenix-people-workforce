import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import {
  loadClosingPerformanceReview,
  PERFORMANCE_REVIEW_MONTHS,
} from "@/lib/sales/closing-performance-review";
import {
  canOpenClosingPerformanceReview,
  canOpenPortalClosingPerformanceReview,
  CLOSING_PERFORMANCE_REVIEW_AUDIENCE_MESSAGE,
  performanceReviewSalesAction,
} from "@/lib/sales/closing-performance-review-access";
import { loadScopedClosingPerformanceReview } from "@/lib/sales/closing-performance-review-portal";
import { buildClosingPerformanceReviewWorkbook } from "@/lib/sales/closing-performance-review-export";
import { parseCodeList, parsePeriodSelection } from "@/lib/sales/monthly-closing-period-merge";

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
 * It rebuilds the review from the SAME service the page rendered from, at the same line, the same
 * month or months, and the same filter, so the file and the screen cannot show different numbers.
 * Nothing about the sheet's CONTENT is passed in from the browser — only which selection to read.
 *
 * The selection travels because the owner's rule is that an export matches the screen. A workbook
 * that quietly covered every region while the reader was looking at Delta, or one month while the
 * screen totalled three, would be different data wearing the same title.
 *
 * It admits exactly who the page admits, asked through the same functions. The permission is not the
 * boundary here: `sales:export` reaches down to Medical Rep, and the review reads every line, region
 * and rep company-wide for whatever month the body names, published or not.
 *
 * 🔴 **A SALES MANAGER'S WORKBOOK IS THE SCOPED READ, RESOLVED FROM HIS OWN ACCESS HERE** (owner,
 * 2026-10-13) — his areas, his published months. The file is the screen, so it has to come through
 * the same bound the screen came through; re-deriving it from the body would hand whoever posts the
 * body the whole line in a downloadable file, which is the one place a leak cannot be taken back.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const isAdminAudience = canOpenClosingPerformanceReview(access);
    if (!isAdminAudience && !canOpenPortalClosingPerformanceReview(access)) {
      return Response.json({ error: CLOSING_PERFORMANCE_REVIEW_AUDIENCE_MESSAGE }, { status: 403 });
    }
    // The file needs whatever its own audience needs to load the review on screen, plus its own key:
    // `import` for the admin audience, `read` for a portal manager (who holds `read` and `export`,
    // never `import` — asserting it here 403'd the Export button for every manager it was built for).
    await assertPermission(access, "sales", performanceReviewSalesAction(isAdminAudience));
    await assertPermission(access, "sales", "export");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:closing-performance-review",
    });

    const body = (await request.json().catch(() => ({}))) as {
      areas?: string[] | string | null;
      line?: string | null;
      months?: number;
      period?: string | null;
      periods?: string[] | string | null;
      products?: string[] | string | null;
      regions?: string[] | string | null;
      search?: string | null;
    };

    const filter = {
      areaCodes: parseCodeList(body.areas),
      productCodes: parseCodeList(body.products),
      regionCodes: parseCodeList(body.regions),
      search: typeof body.search === "string" ? body.search : "",
    };
    const requestedLine = typeof body.line === "string" && body.line.trim() !== "" ? body.line : null;
    const requestedPeriod =
      typeof body.period === "string" && body.period.trim() !== "" ? body.period : null;
    const months = Number.isFinite(body.months) ? Number(body.months) : PERFORMANCE_REVIEW_MONTHS;

    let review;
    if (isAdminAudience) {
      review = await loadClosingPerformanceReview({
        filter,
        line: requestedLine,
        months,
        period: requestedPeriod,
        periods: parsePeriodSelection(body.periods),
      });
    } else {
      const scoped = await loadScopedClosingPerformanceReview({
        access,
        filter,
        months,
        requestedLine,
        requestedPeriod,
        requestedPeriods: parsePeriodSelection(body.periods),
      });
      if (scoped.refusedLine) {
        return Response.json({ error: "That product line is outside your scope." }, { status: 403 });
      }
      if (!scoped.review) {
        return Response.json(
          {
            error: scoped.awaitingPublish
              ? "No month has been published for your line yet."
              : "There is no closing in your scope to export yet.",
          },
          { status: 404 },
        );
      }
      review = scoped.review;
    }

    const buffer = await buildClosingPerformanceReviewWorkbook(review);
    // A multi-month file is named for its span, not for one of the months inside it — a file called
    // "…-2026-09" holding July, August and September is the sort of thing that gets emailed on.
    const periodSlug =
      review.selectedPeriods.length > 1
        ? slug(review.selectedPeriods[0] + "-to-" + review.selectedPeriods[review.selectedPeriods.length - 1])
        : slug(review.period);
    const fileName = `sato-performance-review-${periodSlug}-${slug(review.line)}.xlsx`;
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
