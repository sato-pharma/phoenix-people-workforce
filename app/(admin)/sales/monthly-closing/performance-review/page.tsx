import { redirect } from "next/navigation";

import { ClosingPerformanceReviewWorkspace } from "@/components/sales/closing-performance-review-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import {
  loadClosingPerformanceReview,
  type ClosingPerformanceReview,
} from "@/lib/sales/closing-performance-review";
import {
  canOpenClosingPerformanceReview,
  canOpenPortalClosingPerformanceReview,
} from "@/lib/sales/closing-performance-review-access";

export const dynamic = "force-dynamic";

/**
 * Performance Review — the presentation cut of the Monthly Closing.
 *
 * Super Admin and system scope get it, SFE Manager gets it because he already reads that matrix
 * (owner decision, 2026-08-05), and everyone else reaches the closing through the employee portal.
 * /sales/monthly-closing has also admitted the CEO since 2026-09-07; this page does not.
 *
 * A SALES MANAGER HAS HIS OWN COPY of this review since 2026-10-13, scoped to his territory, at
 * /employee-portals/monthly-closing/performance-review — so a District, Regional or National Sales
 * Manager who follows an admin link is sent THERE rather than to the Source of Sales hub, which is
 * still where every other portal-mode viewer belongs. Both destinations are mirrored in
 * `portal-twins.ts`, which `tests/portal-twin-forwarding.test.ts` re-derives from this source.
 *
 * That audience is `canOpenClosingPerformanceReview`, and both API routes behind this page ask the
 * same function — the export once asked only `sales:export`, which reaches down to Medical Rep. It
 * publishes nothing and mutates nothing — it re-reads the closing and re-shapes it, so there is no
 * write to gate separately.
 */
export default async function ClosingPerformanceReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    if (canOpenPortalClosingPerformanceReview(access)) {
      redirect("/employee-portals/monthly-closing/performance-review");
    }
    redirect("/employee-portals/source-of-sales");
  }

  if (!canOpenClosingPerformanceReview(access)) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const first = (value: string | string[] | undefined): string | null =>
    typeof value === "string" ? value : Array.isArray(value) ? value[0] ?? null : null;

  let initialReview: ClosingPerformanceReview | null = null;
  let initialError: string | null = null;

  try {
    await assertPermission(access, "sales", "import");
    initialReview = await loadClosingPerformanceReview({
      line: first(params.line),
      period: first(params.period),
    });
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load the Performance Review.";
  }

  return <ClosingPerformanceReviewWorkspace initialError={initialError} initialReview={initialReview} />;
}
