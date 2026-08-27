import { redirect } from "next/navigation";

import { ClosingPerformanceReviewWorkspace } from "@/components/sales/closing-performance-review-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import {
  loadClosingPerformanceReview,
  type ClosingPerformanceReview,
} from "@/lib/sales/closing-performance-review";

export const dynamic = "force-dynamic";

/**
 * Performance Review — the presentation cut of the Monthly Closing.
 *
 * Same audience and same gate as /sales/monthly-closing itself: Super Admin and system scope get it,
 * SFE Manager gets it because he already reads that matrix (owner decision, 2026-08-05), and everyone
 * else reaches the closing through the employee portal. It publishes nothing and mutates nothing —
 * it re-reads the closing and re-shapes it, so there is no write to gate separately.
 */
export default async function ClosingPerformanceReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }

  const isSystemAdministratorViewer = access.role === "Super Admin" || access.scope === "system";
  if (!isSystemAdministratorViewer && access.role !== "SFE Manager") {
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
