// S1 Business Review — employee-portal surface. Same LIVE canonical S1 bundle as the admin
// module at /business-review-s1, but every viewer sees only their own scope:
//
//   CEO / SFE Manager / Marketing Manager / Super Admin  → all company, all three lines
//   NSM / GPM / Product Manager                          → their whole line
//   Regional Manager                                     → the DM seats under their RSM node
//   District Manager                                     → their own district's areas
//   Medical Representative                               → no access (owner ruling)
//
// Scope is resolved by src/lib/business-review-s1/portal-scope.ts against a snapshot of the live
// organogram seat map, NOT by matching region labels or DM display names. That shortcut has
// produced a real defect here before (#1479).
//
// Two different timeframes meet on this page and are deliberately not merged: the S1 numbers are
// Jan–Jun history, while the seat map is today. An area that was vacant during S1 can be occupied
// now — so vacancy is reported from the dataset (what happened) while access is resolved from the
// seat map (who may look).
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { S1PortalReview } from "@/components/business-review-s1/portal-review.client";
import {
  applySeatScope,
  resolveS1PortalScope,
  s1AccessMapGeneratedAt,
} from "@/lib/business-review-s1/portal-scope";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import {
  bandFor,
  getS1Company,
  getS1CompanyAreas,
  getS1CompanyDms,
  getS1CompanyProductTables,
  getS1CompanyThresholds,
  getS1Dataset,
  loadS1Review,
  payoutPercentageFor,
  S1_RESTATEMENT_NOTICE,
} from "@/lib/business-review-s1/service";
import type { AreaSummary, DmSummary } from "@/lib/business-review-s1/types";

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

export default async function PortalBusinessReviewS1Page() {
  const access = await resolveAuthenticatedPageAccess();
  const scope = resolveS1PortalScope({ hrId: access.hrId, sessionRole: access.role });

  const shell = (children: React.ReactNode, description: string) => (
    <EmployeePortalPageShell badge="Semester 1 2026" description={description} title="Business Review">
      {children}
    </EmployeePortalPageShell>
  );

  if (scope.kind === "none") {
    return shell(
      <EmployeePortalEmptyState message={scope.reason} title="Not available for your role" />,
      "Executive sales review for Semester 1 2026.",
    );
  }

  // One canonical range call for all three lines, all six months — never per-scope.
  const review = await loadS1Review();

  // ---- company scope: every line, consolidated ----
  if (scope.kind === "company") {
    const company = getS1Company(review);
    return shell(
      <S1PortalReview
        areas={getS1CompanyAreas(review).map(withAreaBand)}
        dms={getS1CompanyDms(review).map(withDmBand)}
        headline="All Company — Semester 1 2026"
        // Per-product columns are omitted company-wide: the three lines sell entirely different
        // catalogues, so one shared product column set would be meaningless.
        keyProducts={[]}
        lineRows={company.lines}
        mapGeneratedAt={s1AccessMapGeneratedAt()}
        months={company.meta.months}
        productTables={getS1CompanyProductTables(review)}
        scopeLabel={scope.label}
        thresholds={getS1CompanyThresholds(review)}
        restatementNotice={S1_RESTATEMENT_NOTICE}
        visitsAvailable
      />,
      `Semester 1 2026 across all three lines, as ${access.role}.`,
    );
  }

  const ds = getS1Dataset(review, scope.line);
  const keyProducts = ds.products.filter((p) => p.include).map((p) => p.product);
  const headline = `${ds.meta.line} Line — Semester 1 2026`;

  // ---- line scope (NSM / GPM / PM): their whole line ----
  if (scope.kind === "line") {
    return shell(
      <S1PortalReview
        areas={ds.areas.map(withAreaBand)}
        dms={ds.dms.map(withDmBand)}
        headline={headline}
        keyProducts={keyProducts}
        lineRows={[]}
        mapGeneratedAt={s1AccessMapGeneratedAt()}
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
        restatementNotice={S1_RESTATEMENT_NOTICE}
        visitsAvailable={ds.visits.available}
      />,
      `Semester 1 2026 for the ${ds.meta.line} line, as ${access.role}.`,
    );
  }

  // ---- seat scope (RM / DSM): only their own territory ----
  // Filtering happens before any ranking or truncation (PR #1487), and every figure the component
  // renders is summed from these rows — it never reads ds.line.*, which is the whole line. The
  // canonical engine attributes every area to a DM seat directly, so this is an exact match, not
  // a reconciliation against a workbook label — see portal-scope.ts's header.
  const { areas, dms } = applySeatScope(ds, scope.dmSeatIds);
  if (areas.length === 0) {
    return shell(
      <EmployeePortalEmptyState
        message={`No S1 sales were attributed to your DM seat${scope.dmSeatIds.length > 1 ? "s" : ""} in the ${ds.meta.line} line's canonical data. This may be a seat-mapping gap rather than an empty territory — please report it before drawing any conclusion.`}
        title="Territory could not be matched"
      />,
      `Semester 1 2026 for your territory, as ${access.role}.`,
    );
  }

  return shell(
    <S1PortalReview
      areas={areas.map(withAreaBand)}
      dms={dms.map(withDmBand)}
      headline={headline}
      keyProducts={keyProducts}
      lineRows={[]}
      mapGeneratedAt={s1AccessMapGeneratedAt()}
      months={ds.meta.months}
      productTables={[]}
      scopeLabel={scope.label}
      thresholds={ds.meta.thresholds}
      restatementNotice={S1_RESTATEMENT_NOTICE}
      visitsAvailable={ds.visits.available}
    />,
    `Semester 1 2026 for your territory, as ${access.role}.`,
  );
}
