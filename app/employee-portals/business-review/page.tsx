// Business Review — employee-portal surface. Same LIVE bundle as the admin module at
// /business-review, but every viewer sees only their own scope:
//
//   CEO / SFE Manager / Marketing Manager / Super Admin  → all company, all three lines
//   NSM / GPM / Product Manager                          → their whole line
//   Regional Manager                                     → the DM seats under their RSM node
//   District Manager                                     → their own district's areas
//   Medical Representative                               → no access (owner ruling)
//
// Scope is resolved by src/lib/business-review/portal-scope.ts against a snapshot of the live
// organogram seat map, NOT by matching region labels or DM display names. That shortcut has
// produced a real defect here before (#1479).
//
// Two different timeframes meet on this page and are deliberately not merged: the numbers are the
// history of whatever window the viewer picked, while the seat map is today. An area that was
// vacant during the window can be occupied now — so vacancy is reported from the dataset (what
// happened) while access is resolved from the seat map (who may look).
//
// The period filter is a URL search param, so changing the window re-runs the scope resolution
// above server-side rather than a client fetch reusing the scope granted for the previous one.
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { BusinessReviewPortal } from "@/components/business-review/portal-review.client";
import {
  applySeatScope,
  resolveReviewPortalScope,
  reviewAccessMapGeneratedAt,
} from "@/lib/business-review/portal-scope";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import {
  bandFor,
  getReviewCompany,
  getReviewCompanyAreas,
  getReviewCompanyDms,
  getReviewCompanyProductTables,
  getReviewCompanyThresholds,
  getReviewDataset,
  loadBusinessReview,
  payoutPercentageFor,
  REVIEW_SOURCE_NOTICE,
} from "@/lib/business-review/service";
import { hasFigures } from "@/lib/business-review/coverage";
import type { AreaSummary, DmSummary } from "@/lib/business-review/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Achievement → payout band, applied on the server so the locked 2026 curve is never shipped
 *  to the browser. */
const withAreaBand = <T extends AreaSummary>(a: T) => ({
  ...a,
  band: bandFor(a.allProducts.ach),
  payoutPct: payoutPercentageFor(a.allProducts.ach),
});
const withDmBand = <T extends DmSummary>(d: T) => ({
  ...d,
  band: bandFor(d.allProducts.ach),
  payoutPct: payoutPercentageFor(d.allProducts.ach),
});

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

type PageProps = {
  searchParams?: Promise<{ from?: string | string[]; to?: string | string[] }>;
};

export default async function PortalBusinessReviewPage({ searchParams }: PageProps) {
  const access = await resolveAuthenticatedPageAccess();
  const scope = resolveReviewPortalScope({ hrId: access.hrId, sessionRole: access.role });

  const shell = (children: React.ReactNode, description: string, badge: string) => (
    <EmployeePortalPageShell badge={badge} description={description} title="Business Review">
      {children}
    </EmployeePortalPageShell>
  );

  if (scope.kind === "none") {
    return shell(
      <EmployeePortalEmptyState message={scope.reason} title="Not available for your role" />,
      "Executive sales review.",
      "Read-only",
    );
  }

  // ONE canonical range call for all three lines and every month in the window — never per scope.
  // `from`/`to` are raw request input and are resolved, not trusted.
  const params = await searchParams;
  const { review, resolution, available } = await loadBusinessReview({
    from: firstSearchParam(params?.from) ?? null,
    to: firstSearchParam(params?.to) ?? null,
  });
  const window = resolution.window;
  const coverage = review.coverage;
  const visitsOk = hasFigures(coverage, "visits");
  const shared = {
    available,
    coverage,
    mapGeneratedAt: reviewAccessMapGeneratedAt(),
    restatementNotice: REVIEW_SOURCE_NOTICE,
    window,
  };

  // ---- company scope: every line, consolidated ----
  if (scope.kind === "company") {
    const company = getReviewCompany(review);
    return shell(
      <BusinessReviewPortal
        {...shared}
        areas={getReviewCompanyAreas(review).map(withAreaBand)}
        dms={getReviewCompanyDms(review).map(withDmBand)}
        headline={`All Company — ${window.label}`}
        // Per-product columns are omitted company-wide: the three lines sell entirely different
        // catalogues, so one shared product column set would be meaningless.
        keyProducts={[]}
        lineRows={company.lines}
        months={company.meta.months}
        productTables={getReviewCompanyProductTables(review)}
        scopeLabel={scope.label}
        thresholds={getReviewCompanyThresholds(review)}
        visitsAvailable={visitsOk}
      />,
      `${window.label} across all three lines, as ${access.role}.`,
      window.label,
    );
  }

  const ds = getReviewDataset(review, scope.line);
  const keyProducts = ds.products.filter((p) => p.include).map((p) => p.product);
  const headline = `${ds.meta.line} Line — ${window.label}`;

  // ---- line scope (NSM / GPM / PM): their whole line ----
  if (scope.kind === "line") {
    return shell(
      <BusinessReviewPortal
        {...shared}
        areas={ds.areas.map(withAreaBand)}
        dms={ds.dms.map(withDmBand)}
        headline={headline}
        keyProducts={keyProducts}
        lineRows={[]}
        months={ds.meta.months}
        productTables={[
          {
            id: scope.line,
            label: ds.meta.line,
            products: ds.products.filter((p) => p.total.target > 0 || p.total.sales > 0),
          },
        ]}
        scopeLabel={scope.label}
        thresholds={ds.meta.thresholds}
        visitsAvailable={ds.visits.available}
      />,
      `${window.label} for the ${ds.meta.line} line, as ${access.role}.`,
      window.label,
    );
  }

  // ---- seat scope (RM / DSM): only their own territory ----
  // Filtering happens before any ranking or truncation (PR #1487), and every figure the component
  // renders is summed from these rows — it never reads ds.line.*, which is the whole line. The
  // canonical engine attributes every area to a DM seat directly, so this is an exact match, not
  // a reconciliation against a workbook label — see portal-scope.ts's header.
  const { areas, dms } = applySeatScope(ds, scope.dmSeatIds);
  if (areas.length === 0) {
    // Two very different causes, and the viewer must not be left to guess which: the window may
    // hold no sales for anybody (coverage says so), or their seat may not be mapped.
    return shell(
      <EmployeePortalEmptyState
        message={
          coverage.empty
            ? `No sales data exists for ${window.label} at all — not for your territory and not for anyone else's. Pick a different period.`
            : `No sales in ${window.label} were attributed to your DM seat${scope.dmSeatIds.length > 1 ? "s" : ""} in the ${ds.meta.line} line's canonical data. This may be a seat-mapping gap rather than an empty territory — please report it before drawing any conclusion.`
        }
        title={coverage.empty ? "No data in this period" : "Territory could not be matched"}
      />,
      `${window.label} for your territory, as ${access.role}.`,
      window.label,
    );
  }

  return shell(
    <BusinessReviewPortal
      {...shared}
      areas={areas.map(withAreaBand)}
      dms={dms.map(withDmBand)}
      headline={headline}
      keyProducts={keyProducts}
      lineRows={[]}
      months={ds.meta.months}
      productTables={[]}
      scopeLabel={scope.label}
      thresholds={ds.meta.thresholds}
      visitsAvailable={ds.visits.available}
    />,
    `${window.label} for your territory, as ${access.role}.`,
    window.label,
  );
}
