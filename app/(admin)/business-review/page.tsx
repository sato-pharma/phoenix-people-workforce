// Business Review — READ-ONLY analytical page inside the Phoenix admin shell
// (sidebar/topbar provided by app/(admin)/layout.tsx). Visible only to CEO, SFE Manager and
// Super Admin.
//
// EVERYTHING ON THIS PAGE IS LIVE AND WINDOW-SCOPED. Sales, targets and achievement come from
// SoS Monthly Closing; marketing, outstation, CRM visits, doctors and per-role activity come
// from their own production tables. No committed workbook feeds a number.
//
// The line switch AND the period filter are URL search params, deliberately: every change is a
// real navigation, so the role gate below re-runs server-side on the new window rather than a
// client fetch reusing the gate that passed for the previous one.
import { redirect } from "next/navigation";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  bandFor,
  DEFAULT_REVIEW_VIEW,
  getReviewCompany,
  getReviewCompanyAreas,
  getReviewCompanyDms,
  getReviewCompanyProductTables,
  getReviewCompanyThresholds,
  getReviewDataset,
  isReviewView,
  loadBusinessReview,
  payoutPercentageFor,
  REVIEW_SOURCE_NOTICE,
  type ReviewView,
} from "@/lib/business-review/service";
import { BusinessReviewDashboard } from "@/components/business-review/dashboard.client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["CEO", "SFE Manager", "Super Admin"]);

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

type PageProps = {
  searchParams?: Promise<{ line?: string | string[]; from?: string | string[]; to?: string | string[] }>;
};

export default async function BusinessReviewPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!ALLOWED_ROLES.has(access.role)) redirect("/admin/access");

  const params = await searchParams;
  const requested = firstSearchParam(params?.line);
  const view: ReviewView = isReviewView(requested) ? requested : DEFAULT_REVIEW_VIEW;

  // ONE canonical range call for all three lines and every month in the window — never per view.
  // `from`/`to` are raw request input and are resolved, not trusted: anything out of range is
  // clamped to a real window and the adjustment is reported on the page.
  const { review, resolution, available } = await loadBusinessReview({
    from: firstSearchParam(params?.from) ?? null,
    to: firstSearchParam(params?.to) ?? null,
  });
  const company = getReviewCompany(review);
  const shared = {
    viewerRole: access.role,
    company,
    restatementNotice: REVIEW_SOURCE_NOTICE,
    window: resolution.window,
    coverage: review.coverage,
    provenance: review.provenance,
    available,
  };

  // The company rollup is cross-line: it consolidates every line's areas and DM seats
  // instead of loading a single per-line dataset.
  if (view === "company") {
    return (
      <BusinessReviewDashboard
        {...shared}
        view="company"
        companyDms={getReviewCompanyDms(review).map((d) => ({
          ...d,
          payoutPct: payoutPercentageFor(d.allProducts.ach),
          band: bandFor(d.allProducts.ach),
          activePayoutPct: payoutPercentageFor(d.activeIncludeOnly.ach),
          activeBand: bandFor(d.activeIncludeOnly.ach),
        }))}
        companyAreas={getReviewCompanyAreas(review).map((a) => ({
          ...a,
          payoutPct: payoutPercentageFor(a.allProducts.ach),
          band: bandFor(a.allProducts.ach),
        }))}
        companyProductTables={getReviewCompanyProductTables(review)}
        companyThresholds={getReviewCompanyThresholds(review)}
      />
    );
  }

  const ds = getReviewDataset(review, view);
  const dms = ds.dms.map((d) => ({
    ...d,
    payoutPct: payoutPercentageFor(d.allProducts.ach),
    band: bandFor(d.allProducts.ach),
    activePayoutPct: payoutPercentageFor(d.activeIncludeOnly.ach),
    activeBand: bandFor(d.activeIncludeOnly.ach),
  }));
  const areas = ds.areas.map((a) => ({
    ...a,
    payoutPct: payoutPercentageFor(a.allProducts.ach),
    band: bandFor(a.allProducts.ach),
  }));

  return <BusinessReviewDashboard {...shared} view={view} ds={ds} dms={dms} areas={areas} />;
}
