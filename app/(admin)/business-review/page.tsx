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
import { ReviewScopeFilter } from "@/components/business-review/scope-filter.client";
import {
  defaultSelectionFor,
  narrowSelection,
  type PackLevel,
} from "@/lib/business-review/pack/metrics";
import { loadReviewPortalScope } from "@/lib/business-review/portal-scope";
import {
  filterChoices,
  filterParams,
  resolveReviewFilter,
  REVIEW_LINE_ORDER,
  territoriesInScope,
} from "@/lib/business-review/scope-filter";
import type { ReviewLine } from "@/lib/business-review/canonical";
import type { AreaSummary } from "@/lib/business-review/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["CEO", "SFE Manager", "Super Admin"]);

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

type PageProps = {
  searchParams?: Promise<{
    line?: string | string[];
    from?: string | string[];
    to?: string | string[];
    /** The territory narrowing — region and area may each be several (2026-09-27). */
    region?: string | string[];
    area?: string | string[];
    dm?: string | string[];
    /** The export pack's chosen metrics, same convention as the portal: absent = this level's defaults. */
    m?: string | string[];
  }>;
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
  // STARTED EARLY (2026-10-23, performance brief): the seat map below depends on the session
  // alone, never on the review, so it is read beside the company-wide read instead of after it.
  // It starts only after the role gate above, and the guard keeps a rejection from surfacing
  // unhandled while the review loads; the await below still throws it.
  const scopeLoad = loadReviewPortalScope({ hrId: access.hrId ?? null, sessionRole: access.role });
  scopeLoad.catch(() => {});
  const { review, resolution, available } = await loadBusinessReview({
    from: firstSearchParam(params?.from) ?? null,
    to: firstSearchParam(params?.to) ?? null,
  });
  const company = getReviewCompany(review);

  // ── territory narrowing (region / district / area), within the current view's line ──
  //
  // The admin picks the LINE with the view tabs, so the filter here offers only region, district and
  // area (hideLine). It narrows through the SAME module the export route uses (`territoriesInScope`
  // built from the session, `resolveReviewFilter` that can only remove), so a value in the URL can
  // never widen the scope — the guarantee the whole scope-filter module exists for. Region and area
  // may each be several (owner, 2026-09-27).
  const { scope } = await scopeLoad;
  const scopeLines: ReviewLine[] =
    scope.kind === "company" ? [...REVIEW_LINE_ORDER] : scope.kind === "none" ? [] : [scope.line];
  const areasByLine: Partial<Record<ReviewLine, AreaSummary[]>> = {};
  for (const line of scopeLines) areasByLine[line] = getReviewDataset(review, line).areas;
  const scopedTerritories = territoriesInScope(scope, areasByLine);
  const filter = resolveReviewFilter(scope, scopedTerritories, {
    area: params?.area ?? null,
    dm: firstSearchParam(params?.dm) ?? null,
    line: view === "company" ? null : view,
    region: params?.region ?? null,
  });
  const narrowed =
    filter.applied.regions.length > 0 || filter.applied.areaCodes.length > 0 || filter.applied.dmSeatId != null;

  // The export pack the portal already offers, now on the admin shell too. The SCOPE is resolved from
  // the SESSION inside /api/business-review/pack — never from here; the pack link carries the current
  // line AND the applied narrowing as a FILTER. The metric catalogue follows the narrowing: a filtered
  // view answers district questions, the whole view answers its own level.
  const packLevel: PackLevel = narrowed ? filter.level : view === "company" ? "company" : "line";
  const requestedMetrics = params?.m == null ? null : (Array.isArray(params.m) ? params.m : [params.m]).filter(Boolean);
  const packMetrics = requestedMetrics == null ? defaultSelectionFor(packLevel) : narrowSelection(requestedMetrics, packLevel);

  const exportParams = filterParams(filter.applied);
  // The control offers the current view's line only, minus the line control itself (the tabs own it).
  const choiceTerritories = view === "company" ? scopedTerritories : scopedTerritories.filter((t) => t.line === view);
  const scopeFilter = (
    <ReviewScopeFilter
      action="/business-review"
      applied={filter.applied}
      choices={filterChoices(choiceTerritories)}
      dropped={filter.dropped}
      hidden={{ from: resolution.window.from, line: view, to: resolution.window.to }}
      hideLine
      metrics={packMetrics}
    />
  );

  // Which territories survived, so the on-screen tables narrow with the tiles and the export.
  const keptAreaKeys = new Set(filter.territories.map((t) => `${t.line}:${t.areaCode ?? ""}`));
  const keptSeats = new Set(filter.dmSeatIds);

  const shared = {
    viewerRole: access.role,
    company,
    restatementNotice: REVIEW_SOURCE_NOTICE,
    window: resolution.window,
    coverage: review.coverage,
    provenance: review.provenance,
    available,
    packLevel,
    packMetrics,
    scopeFilter,
    exportParams,
    narrowed,
    scopeLabel: filter.label,
  };

  // The company rollup is cross-line: it consolidates every line's areas and DM seats
  // instead of loading a single per-line dataset.
  if (view === "company") {
    const companyDms = getReviewCompanyDms(review)
      .filter((d) => !narrowed || (d.dmSeatId != null && keptSeats.has(d.dmSeatId)))
      .map((d) => ({
        ...d,
        payoutPct: payoutPercentageFor(d.allProducts.ach),
        band: bandFor(d.allProducts.ach),
        activePayoutPct: payoutPercentageFor(d.activeIncludeOnly.ach),
        activeBand: bandFor(d.activeIncludeOnly.ach),
      }));
    const companyAreas = getReviewCompanyAreas(review)
      .filter((a) => !narrowed || keptAreaKeys.has(`${a.lineId}:${a.areaCode ?? ""}`))
      .map((a) => ({
        ...a,
        payoutPct: payoutPercentageFor(a.allProducts.ach),
        band: bandFor(a.allProducts.ach),
      }));
    return (
      <BusinessReviewDashboard
        {...shared}
        view="company"
        companyDms={companyDms}
        companyAreas={companyAreas}
        companyProductTables={getReviewCompanyProductTables(review)}
        companyThresholds={getReviewCompanyThresholds(review)}
      />
    );
  }

  const ds = getReviewDataset(review, view);
  const survivingCodes = new Set(
    filter.territories.filter((t) => t.line === view && t.areaCode != null).map((t) => t.areaCode as string),
  );
  const dms = ds.dms
    .filter((d) => !narrowed || (d.dmSeatId != null && keptSeats.has(d.dmSeatId)))
    .map((d) => ({
      ...d,
      payoutPct: payoutPercentageFor(d.allProducts.ach),
      band: bandFor(d.allProducts.ach),
      activePayoutPct: payoutPercentageFor(d.activeIncludeOnly.ach),
      activeBand: bandFor(d.activeIncludeOnly.ach),
    }));
  const areas = ds.areas
    .filter((a) => !narrowed || (a.areaCode != null && survivingCodes.has(a.areaCode)))
    .map((a) => ({
      ...a,
      payoutPct: payoutPercentageFor(a.allProducts.ach),
      band: bandFor(a.allProducts.ach),
    }));

  return <BusinessReviewDashboard {...shared} view={view} ds={ds} dms={dms} areas={areas} />;
}
