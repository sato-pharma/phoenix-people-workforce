import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { ClosingPerformanceReviewWorkspace } from "@/components/sales/closing-performance-review-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canOpenPortalClosingPerformanceReview } from "@/lib/sales/closing-performance-review-access";
import { longMonthLabel } from "@/lib/sales/closing-performance-review-regions";
import { loadScopedClosingPerformanceReview } from "@/lib/sales/closing-performance-review-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Performance Review — a sales manager's own tab.
 *
 * Owner, 2026-10-13: "show performance review tab in each district manager account … and of course,
 * everyone sees only his scope." A District Manager reads his own areas, a Regional Manager his
 * region, a National Sales Manager his line — the same six views the admin screen shows, over his
 * own rows, with the rankings re-derived from them so "3rd" counts the reps he actually runs.
 *
 * THREE SERVER-SIDE GATES, the same three the portal Monthly Closing has carried since 2026-07-30:
 * the role gate (`canOpenPortalClosingPerformanceReview`), `assertPermission(sales, read)`, and the
 * per-viewer bound inside `loadScopedClosingPerformanceReview` — his line, his geography, his
 * products, confidential columns stripped. The route the page re-reads from and the route behind its
 * Export button resolve that bound from the caller's OWN access, so nothing the browser sends can
 * widen it.
 *
 * PUBLISHED-GATED, AND FLOORED AT JULY. His months are exactly the ones published for his line, from
 * July 2026 upward — the review's first period, and his own correction the same day: "no show
 * performance review in emp portal starting from july". Nothing below that floor is offered here or
 * on the admin screen, because those months were closed on an earlier area map. A month with no
 * target backfilled shows its sales and reads "no target" rather than 0%.
 */
export default async function PortalClosingPerformanceReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!canOpenPortalClosingPerformanceReview(access)) redirect(resolveLandingPathForRole(access.role));
  await assertPermission(access, "sales", "read");

  const params = await searchParams;
  const first = (value: string | string[] | undefined): string | null =>
    typeof value === "string" ? value : Array.isArray(value) ? value[0] ?? null : null;

  let scoped: Awaited<ReturnType<typeof loadScopedClosingPerformanceReview>> | null = null;
  let loadError: string | null = null;
  try {
    scoped = await loadScopedClosingPerformanceReview({
      access,
      // Almost every manager holds exactly one line and never sends this. It exists for the one who
      // legitimately covers more, and a line outside his scope is REFUSED below, never substituted.
      requestedLine: first(params.line),
      requestedPeriod: first(params.period),
    });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load the Performance Review.";
  }

  const body = () => {
    if (loadError || !scoped) {
      return (
        <EmployeePortalEmptyState
          message={loadError ?? "The Performance Review is unavailable right now — refresh to try again."}
          title="Performance Review unavailable"
        />
      );
    }
    if (scoped.refusedLine) {
      return (
        <EmployeePortalEmptyState
          message="That product line is outside your scope, so there is no review to show for it. Open the page without a line to read your own."
          title="Line outside your scope"
        />
      );
    }
    if (!scoped.line) {
      return (
        <EmployeePortalEmptyState
          message="We couldn't resolve a product line for your account, so there is no review to show. Ask HR to confirm your line assignment."
          title="No line on file"
        />
      );
    }
    // A month that WAS published for him and then could not be read — its closing batch was replaced
    // or invalidated after publication. It is refused by name rather than quietly answered with the
    // newest month the closing happens to hold, which would be an unpublished one under his heading.
    if (!scoped.review && scoped.refusedPeriods.length > 0) {
      return (
        <EmployeePortalEmptyState
          message={`${scoped.refusedPeriods.map(longMonthLabel).join(", ")} cannot be read for ${scoped.line} right now — that month's closing has changed since it was published. Open the page without a month to read your newest published one.`}
          title="Month unavailable"
        />
      );
    }
    if (scoped.awaitingPublish || !scoped.review) {
      return (
        <EmployeePortalEmptyState
          message={
            scoped.availableLines.length > 0
              ? `No month has been published for ${scoped.line} yet. Already published for you: ${scoped.availableLines.join(", ")}.`
              : `No month has been published for ${scoped.line} yet. Your Performance Review will appear here once it is published.`
          }
          title="Awaiting publish"
        />
      );
    }
    // 🔴 NO ROWS IS SAID IN WORDS, NEVER SHOWN AS ZEROES — and never widened to cover it. His areas
    // are absent from this month's closing (a seat whose areas have no sales in it, or a region label
    // the line does not carry), and the narrowing refuses to fall back to the whole line, so the
    // honest answer is that there is nothing of his in it.
    if (scoped.review.areas.length === 0) {
      return (
        <EmployeePortalEmptyState
          message={`None of your areas appears in the ${scoped.line} closing for ${longMonthLabel(scoped.review.period)}. Pick another month, or ask Sales Operations to check your areas against that month's closing.`}
          title="Nothing of yours in this month"
        />
      );
    }
    return (
      <ClosingPerformanceReviewWorkspace
        chrome="portal"
        initialError={
          // A month he asked for that is not published for him is NAMED. Silently loading the ones
          // that happen to be published would print a total covering fewer months than he chose.
          scoped.refusedPeriods.length > 0
            ? `Not published for you yet: ${scoped.refusedPeriods.join(", ")} — the figures below cover your published months only.`
            : null
        }
        initialReview={scoped.review}
        scopeNote={scoped.scopeNote}
      />
    );
  };

  return (
    <EmployeePortalPageShell
      badge="Sales Operations"
      description="Who sold what in your territory, ranked. Your reps and areas against target, then the same rows broken down by product and by area, month by month across every published month from July 2026. Export downloads exactly these views as a Sato workbook."
      errorBoundaryTitle="Performance Review unavailable"
      title="Performance Review"
    >
      {body()}
    </EmployeePortalPageShell>
  );
}
