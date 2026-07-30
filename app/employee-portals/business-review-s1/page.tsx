// S1 Business Review — employee-portal surface. Same verified S1 datasets as the admin module
// at /business-review-s1, but every viewer sees only their own scope:
//
//   CEO / SFE Manager / Marketing Manager / Super Admin  → all company, all three lines
//   NSM / GPM / Product Manager                          → their whole line
//   Regional Manager                                     → the DM seats under their RSM node
//   District Manager                                     → their own district's areas
//   Medical Representative                               → no access (owner ruling)
//
// Scope is resolved by src/lib/business-review-s1/portal-scope.ts against a snapshot of the live
// organogram seat map, NOT by matching region labels or DM display names. Both shortcuts have
// produced real defects here (#1479, and the name-mismatch class of bugs found while building
// this module's datasets).
//
// Two different timeframes meet on this page and are deliberately not merged: the S1 numbers are
// Jan–Jun history, while the seat map is today. An area that was vacant during S1 can be occupied
// now — so vacancy is reported from the dataset (what happened) while access is resolved from the
// seat map (who may look).
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { S1PortalReview } from "@/components/business-review-s1/portal-review.client";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import {
  applyAreaScope,
  resolveS1PortalScope,
  s1AccessMapGeneratedAt,
} from "@/lib/business-review-s1/portal-scope";
import {
  bandFor,
  getS1Company,
  getS1CompanyAreas,
  getS1CompanyDms,
  getS1CompanyProductTables,
  getS1CompanyThresholds,
  getS1Dataset,
  payoutPercentageFor,
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

  // ---- company scope: every line, consolidated ----
  if (scope.kind === "company") {
    const company = getS1Company();
    return shell(
      <S1PortalReview
        areas={getS1CompanyAreas().map(withAreaBand)}
        dms={getS1CompanyDms().map(withDmBand)}
        headline="All Company — Semester 1 2026"
        // Per-product columns are omitted company-wide: the three lines sell entirely different
        // catalogues, so one shared product column set would be meaningless.
        keyProducts={[]}
        lineRows={company.lines}
        mapGeneratedAt={s1AccessMapGeneratedAt()}
        months={company.meta.months}
        productTables={getS1CompanyProductTables()}
        scopeLabel={scope.label}
        thresholds={getS1CompanyThresholds()}
        // Every area of every line is on this page, so nothing is missing from these totals.
        caveat={{ kind: "none" }}
        visitsAvailable
      />,
      `Semester 1 2026 across all three lines, as ${access.role}.`,
    );
  }

  const ds = getS1Dataset(scope.line);
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
        // The whole line is on the page, so nothing is missing from these totals.
        caveat={{ kind: "none" }}
        visitsAvailable={ds.visits.available}
      />,
      `Semester 1 2026 for the ${ds.meta.line} line, as ${access.role}.`,
    );
  }

  // ---- area scope (RM / DSM): only their own territory ----
  // Filtering happens before any ranking or truncation (PR #1487), and every figure the component
  // renders is summed from these rows — it never reads ds.line.*, which is the whole line.
  const { areas, dms } = applyAreaScope(scope.line, scope.areaNames);
  if (areas.length === 0) {
    // resolveS1PortalScope guarantees a non-empty area list, so reaching here means the access
    // map names areas this dataset no longer has. Fail closed and say so, rather than render an
    // empty review that reads as "you sold nothing".
    return shell(
      <EmployeePortalEmptyState
        message={`Your territory resolved to ${scope.areaNames.length} area(s) that are not present in the ${ds.meta.line} dataset. This is a mapping fault, not a performance result — please report it before drawing any conclusion.`}
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
      // No area names from outside their team, ever. The only caveat they can see is that their
      // OWN seat could not be reconciled 1:1 with the workbook — empty for every seat but
      // Pedia's Giza/Cairo pair, so a normal district sees no warning at all.
      caveat={{ kind: "partial", seats: scope.partialSeats }}
      visitsAvailable={ds.visits.available}
    />,
    `Semester 1 2026 for your territory, as ${access.role}.`,
  );
}
