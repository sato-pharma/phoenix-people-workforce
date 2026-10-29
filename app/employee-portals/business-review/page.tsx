// Business Review — employee-portal surface. Same LIVE bundle as the admin module at
// /business-review, but every viewer sees only their own scope:
//
//   CEO / SFE Manager / Marketing Manager / Super Admin  → all company, all three lines
//   NSM / GPM / Product Manager                          → their whole line
//   Regional Manager                                     → the DM seats under their RSM node
//   District Manager (incl. ACTING)                      → their own district's areas
//   Medical Representative                               → his own areas only, no district row
//                                                          (owner opened it 2026-09-26, sidebar
//                                                           link added 2026-09-30)
//
// An ACTING district manager is a District Manager here, in full — owner rule, AGENTS.md §4.
//
// Scope is resolved by src/lib/business-review/portal-scope.ts against the LIVE organogram seat
// map, NOT by matching region labels or DM display names. That shortcut has produced a real defect
// here before (#1479). It was resolved against a committed snapshot of that map until 2026-09-12,
// when seven serving district managers were found to be locked out of the module by a file six
// weeks out of date; the snapshot is no longer in the request path. The same resolver then read
// `seat_tier IN ('DM','RSM')` until 2026-09-26, which locked out the one serving ACTING district
// manager while the admin page listed her district from the same canonical rows.
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
import { RepBusinessReview } from "@/components/business-review/rep-review.client";
import {
  applyRepScope,
  applySeatScope,
  loadReviewPortalScope,
  mayHoldReviewScope,
} from "@/lib/business-review/portal-scope";
import { concentrationForAreas, type ConcentrationFacts } from "@/lib/business-review/concentration";
import { PackPicker } from "@/components/business-review/pack-picker.client";
import { ReviewScopeFilter } from "@/components/business-review/scope-filter.client";
import {
  filterChoices,
  filterParams,
  resolveReviewFilter,
  REVIEW_LINE_ORDER,
  territoriesInScope,
} from "@/lib/business-review/scope-filter";
import type { ReviewLine } from "@/lib/business-review/canonical";
import { peopleForReviewFilter, peopleInReviewView } from "@/lib/business-review/people-view";
import type { ReviewPersonRow } from "@/lib/business-review/sources/roles";
import {
  defaultSelectionFor,
  narrowSelection,
  needsClosingDetail,
} from "@/lib/business-review/pack/metrics";
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
  loadReviewConcentration,
  REVIEW_LINE_CODES,
  payoutPercentageFor,
  REVIEW_SOURCE_NOTICE,
} from "@/lib/business-review/service";
import { figureWindowLabel, hasFigures } from "@/lib/business-review/coverage";
import { reviewRepName } from "@/lib/business-review/rep-name";
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
  searchParams?: Promise<{
    /** The territory narrowing: line, region, district seat, area code. */
    area?: string | string[];
    dm?: string | string[];
    from?: string | string[];
    line?: string | string[];
    m?: string | string[];
    region?: string | string[];
    to?: string | string[];
  }>;
};

export default async function PortalBusinessReviewPage({ searchParams }: PageProps) {
  const access = await resolveAuthenticatedPageAccess();
  // `from`/`to` are raw request input and are resolved, not trusted — see loadBusinessReview.
  const params = await searchParams;
  const reviewWindow = {
    from: firstSearchParam(params?.from) ?? null,
    to: firstSearchParam(params?.to) ?? null,
  };
  // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"): the review bundle is
  // the same for every viewer of a window — it depends on `from`/`to` alone, never on the scope — so
  // it no longer waits for the seat map. Only for a role that can hold a scope at all: a role the
  // resolver always refuses never sets off the company-wide read. A viewer refused below never
  // awaits it, and the guard keeps that rejection, if any, from surfacing unhandled.
  const reviewLoad = mayHoldReviewScope(access.role) ? loadBusinessReview(reviewWindow) : null;
  reviewLoad?.catch(() => {});
  const { scope, resolvedAt } = await loadReviewPortalScope({
    hrId: access.hrId,
    sessionRole: access.role,
  });

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
  const { review, resolution, available } = await (reviewLoad ?? loadBusinessReview(reviewWindow));
  const window = resolution.window;
  const coverage = review.coverage;
  // The span the figures ANSWER, which is the requested window minus any month whose distributor
  // files have not landed. Owner ruling 2026-09-26 — every heading on this page names it, never the
  // requested range, because the spend and activity halves stop at the same month as the sales now.
  const figureLabel = figureWindowLabel(coverage);

  // WHAT THIS REVIEW SHOWS. Absent `m` means this level's defaults; `m` present — even empty —
  // means exactly that selection, so a viewer can strip the page back to its headline. Whatever
  // arrives is narrowed to what the level can answer, because a pack link built at company level
  // may well be opened by a district manager and rendering an empty Line comparison would tell him
  // his line has no data.
  const requested = params?.m == null ? null : (Array.isArray(params.m) ? params.m : [params.m]).filter(Boolean);
  const visitsOk = hasFigures(coverage, "visits");
  const shared = {
    available,
    coverage,
    mapGeneratedAt: resolvedAt,
    restatementNotice: REVIEW_SOURCE_NOTICE,
    window,
  };

  // ---- MEDICAL REP: his own frontend, built from scratch (owner, 2026-09-30) ----
  //
  // A rep gets a purpose-built page (RepBusinessReview), NOT the manager dashboard scoped down. It
  // is intercepted HERE, before any of the manager machinery below (line comparison, the DM league
  // table, the vacant/gap tabs, the exclude-vacant toggle), because none of that concerns someone
  // with no team and no districts. He sees his own areas, his own products, his own months, his own
  // field activity and where his money came from — and exports the full pack of exactly that scope.
  // Golden rule #1: his app is easy, and it is blind — no integrity signal reaches this page.
  if (scope.kind === "rep") {
    const repDs = getReviewDataset(review, scope.line);
    const mine = applyRepScope(repDs, scope.hrId);
    if (mine.areas.length === 0) {
      return shell(
        <EmployeePortalEmptyState
          message={
            coverage.empty
              ? `No sales data exists for ${figureLabel} at all — not for your areas and not for anyone else's. Pick a different period.`
              : `No sales in ${figureLabel} were attributed to you in the ${repDs.meta.line} line's canonical data. If you carried a territory in these months, this is an attribution gap rather than an empty area — please report it before drawing any conclusion.`
          }
          title={coverage.empty ? "No data in this period" : "Your territory could not be matched"}
        />,
        `${figureLabel} for your own areas, as ${access.role}.`,
        figureLabel,
      );
    }
    const metrics = requested == null ? defaultSelectionFor("rep") : narrowSelection(requested, "rep");
    // Where his money came from — his bricks, his customers, his channel. A separate customer-grain
    // read, loaded only for him and narrowed to his own areas; a failed read drops that one panel and
    // leaves the rest of his page correct.
    let repConcentration: ConcentrationFacts | null = null;
    try {
      // His own line only: `byLine` for that line is all this reads (2026-10-01, speed).
      const detail = await loadReviewConcentration({ coverage, viewer: access, lines: [scope.line] });
      repConcentration = concentrationForAreas(
        detail.byLine[REVIEW_LINE_CODES[scope.line]] ?? [],
        mine.areas.map((a) => a.areaCode),
      );
    } catch {
      repConcentration = null;
    }
    // His own name, taken from the review's people rows (the session's AccessContext carries none),
    // so his page and the pack he exports read as HIS and he feels seen (owner, 2026-09-30). A rep
    // those rows do not hold is asked of `employees` — never headed with her HR id (`reviewRepName`).
    const repName = await reviewRepName({ fallback: scope.viewerName, hrId: scope.hrId, people: repDs.people });
    return shell(
      <RepBusinessReview
        areas={mine.areas.map(withAreaBand)}
        available={available}
        concentration={repConcentration}
        coverage={coverage}
        headline={`${repName} · ${repDs.meta.line} Line`}
        keyProducts={repDs.products.filter((p) => p.include).map((p) => p.product)}
        lineLabel={repDs.meta.line}
        mapGeneratedAt={resolvedAt}
        months={repDs.meta.months}
        picker={
          <PackPicker
            action="/employee-portals/business-review"
            hidden={{ from: window.from, to: window.to }}
            level="rep"
            selected={metrics}
          />
        }
        scopeLabel={`${repName} · ${repDs.meta.line}`}
        visitsAvailable={repDs.visits.available}
        window={window}
        windowHidden={{}}
      />,
      `${figureLabel} for your own areas, as ${access.role}.`,
      figureLabel,
    );
  }

  // ---- what this viewer is LOOKING at, inside what he may see ----
  //
  // Owner, 2026-09-26, on the portal page: "the pages are very long and impossible for anyone to be
  // able to extract data." Measured on production the same day: 10,676px of page — 10.1 screens —
  // of which the 144-row area table alone was 7,376px. This narrowing is the answer: a district
  // manager reads his five areas instead of scrolling past everyone else's.
  //
  // 🔴 THE SCOPE IS BUILT FIRST, FROM THE SESSION, AND THE REQUEST ONLY REMOVES FROM IT. Identical
  // to what the export route does, deliberately — the file a manager downloads is built from the
  // same narrowing as the screen he built it from, so the two cannot disagree.
  const scopeLines: ReviewLine[] = scope.kind === "company" ? [...REVIEW_LINE_ORDER] : [scope.line];
  const areasByLine: Partial<Record<ReviewLine, AreaSummary[]>> = {};
  for (const line of scopeLines) {
    const lineDs = getReviewDataset(review, line);
    // The rep is intercepted at the top of this function, so only company/line/seat scopes reach
    // here: a seat scope narrows to its DM seats, everything else is the whole line's areas.
    areasByLine[line] =
      scope.kind === "seats" ? applySeatScope(lineDs, scope.dmSeatIds).areas : lineDs.areas;
  }
  const scopedTerritories = territoriesInScope(scope, areasByLine);
  const filter = resolveReviewFilter(scope, scopedTerritories, {
    // region and area may be several — the multi-select submits repeated params (2026-09-27). The
    // resolver still only narrows, so a list from a forwarded link cannot widen this viewer's scope.
    area: params?.area ?? null,
    dm: firstSearchParam(params?.dm) ?? null,
    line: firstSearchParam(params?.line) ?? null,
    region: params?.region ?? null,
  });
  const narrowed =
    filter.applied.line != null ||
    filter.applied.regions.length > 0 ||
    filter.applied.dmSeatId != null ||
    filter.applied.areaCodes.length > 0;
  const appliedParams = filterParams(filter.applied);
  const scopeFilterFor = (metrics: readonly string[]) => (
    <ReviewScopeFilter
      action="/employee-portals/business-review"
      applied={filter.applied}
      choices={filterChoices(scopedTerritories)}
      dropped={filter.dropped}
      hidden={{ from: window.from, to: window.to }}
      metrics={metrics}
    />
  );
  // Everything a link must carry so one control does not undo another.
  const carry = { ...appliedParams, from: window.from, to: window.to };

  // ---- a narrowed view: one line, one region, one district or one area ----
  if (narrowed) {
    const metrics =
      requested == null ? defaultSelectionFor(filter.level) : narrowSelection(requested, filter.level);
    const keptAreas = new Set(filter.territories.map((t) => `${t.line}:${t.areaCode ?? ""}`));
    const keptSeats = new Set(filter.dmSeatIds);
    const fAreas: AreaSummary[] = [];
    const fDms: DmSummary[] = [];
    const peopleByLine: Partial<Record<ReviewLine, readonly ReviewPersonRow[]>> = {};
    let months: string[] = [];

    for (const line of filter.lines) {
      const lineDs = getReviewDataset(review, line);
      months = lineDs.meta.months;
      peopleByLine[line] = lineDs.people;
      for (const a of areasByLine[line] ?? []) {
        if (keptAreas.has(`${line}:${a.areaCode ?? ""}`)) fAreas.push(a);
      }
      for (const d of lineDs.dms) {
        if (d.dmSeatId != null && keptSeats.has(d.dmSeatId)) fDms.push(d);
      }
    }
    // The same people the pack exports — a manager who rode in these districts is in them, whether or
    // not he logged a visit of his own (owner, 2026-10-20). See people-view.ts.
    const fPeople = peopleForReviewFilter({
      companyPeople: getReviewCompany(review).people,
      filter,
      peopleByLine,
      scope,
    });

    const only = filter.lines.length === 1 ? filter.lines[0] : null;
    const onlyDs = only ? getReviewDataset(review, only) : null;

    let narrowedConcentration: ConcentrationFacts | null = null;
    try {
      if (needsClosingDetail(metrics)) {
        // The filtered lines only: `byLine` for those is all this reads (2026-10-01, speed).
        const detail = await loadReviewConcentration({ coverage, viewer: access, lines: filter.lines });
        const rows = filter.lines.flatMap((line) => detail.byLine[REVIEW_LINE_CODES[line]] ?? []);
        narrowedConcentration = concentrationForAreas(rows, fAreas.map((a) => a.areaCode));
      }
    } catch {
      narrowedConcentration = null;
    }

    return shell(
      <BusinessReviewPortal
        {...shared}
        areas={fAreas.map(withAreaBand)}
        concentration={narrowedConcentration}
        dms={fDms.map(withDmBand)}
        headline={`${filter.label} — ${figureLabel}`}
        keyProducts={onlyDs ? onlyDs.products.filter((p) => p.include).map((p) => p.product) : []}
        lineRows={[]}
        metrics={metrics}
        months={months}
        people={fPeople}
        picker={
          <PackPicker
            action="/employee-portals/business-review"
            hidden={carry}
            level={filter.level}
            selected={metrics}
          />
        }
        productTables={
          onlyDs && only
            ? [
                {
                  id: only,
                  label: onlyDs.meta.line,
                  products: onlyDs.products.filter((p) => p.total.target > 0 || p.total.sales > 0),
                },
              ]
            : []
        }
        scopeFilter={scopeFilterFor(metrics)}
        scopeLabel={filter.label}
        // Marketing and outstation are the districts actually shown. The rep, whose district spend
        // would read as his, is intercepted long before this narrowed manager view.
        spend={{
          marketing: fDms.reduce((sum, d) => sum + d.marketingCost, 0),
          outstation: fDms.reduce((sum, d) => sum + d.outstationCost, 0),
        }}
        thresholds={onlyDs ? onlyDs.meta.thresholds : getReviewCompanyThresholds(review)}
        visitsAvailable={onlyDs ? onlyDs.visits.available : visitsOk}
        windowHidden={appliedParams}
      />,
      `${figureLabel} — ${filter.label}, as ${access.role}.`,
      figureLabel,
    );
  }

  // ---- company scope: every line, consolidated ----
  if (scope.kind === "company") {
    const company = getReviewCompany(review);
    // What this review shows, and what an export carries — the same list, so the file a manager
    // hands round cannot disagree with the screen he built it from. Absent `m` means this level's
    // defaults; `m` present but empty means exactly that, so the page can be stripped to a headline.
    const metrics = requested == null ? defaultSelectionFor("company") : narrowSelection(requested, "company");
    return shell(
      <BusinessReviewPortal
        {...shared}
        metrics={metrics}
        scopeFilter={scopeFilterFor(metrics)}
        windowHidden={appliedParams}
        picker={
          <PackPicker
            action="/employee-portals/business-review"
            hidden={carry}
            level="company"
            selected={metrics}
          />
        }
        areas={getReviewCompanyAreas(review).map(withAreaBand)}
        dms={getReviewCompanyDms(review).map(withDmBand)}
        spend={{ marketing: company.total.marketingCost, outstation: company.total.outstationCost }}
        headline={`All Company — ${figureLabel}`}
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
      `${figureLabel} across all three lines, as ${access.role}.`,
      figureLabel,
    );
  }

  const ds = getReviewDataset(review, scope.line);
  const keyProducts = ds.products.filter((p) => p.include).map((p) => p.product);
  const headline = `${ds.meta.line} Line — ${figureLabel}`;

  // ---- line scope (NSM / GPM / PM): their whole line ----
  if (scope.kind === "line") {
    // What this review shows, and what an export carries — the same list, so the file a manager
    // hands round cannot disagree with the screen he built it from. Absent `m` means this level's
    // defaults; `m` present but empty means exactly that, so the page can be stripped to a headline.
    const metrics = requested == null ? defaultSelectionFor("line") : narrowSelection(requested, "line");
    return shell(
      <BusinessReviewPortal
        {...shared}
        metrics={metrics}
        scopeFilter={scopeFilterFor(metrics)}
        windowHidden={appliedParams}
        picker={
          <PackPicker
            action="/employee-portals/business-review"
            hidden={carry}
            level="line"
            selected={metrics}
          />
        }
        areas={ds.areas.map(withAreaBand)}
        dms={ds.dms.map(withDmBand)}
        spend={{ marketing: ds.line.marketingCost, outstation: ds.line.outstationCost }}
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
      `${figureLabel} for the ${ds.meta.line} line, as ${access.role}.`,
      figureLabel,
    );
  }

  // The rep is handled at the top of this function by RepBusinessReview — his own from-scratch page,
  // intercepted before all the manager machinery above. Nothing rep-shaped reaches this far.

  // ---- the customer-grain read, for a district and only for a district ----
  //
  // Where this district's money came from — bricks, customers, channel. Loaded HERE rather than in
  // the bundle because the bundle is cached across viewers and these rows are not the same for
  // everyone: El Qema's are removed for all but the Super Admin. See loadReviewConcentration.
  //
  // A district only. The company and line views above are already rendered, and a rep's own panel
  // is a separate ruling — neither pays for this read.

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
            ? `No sales data exists for ${figureLabel} at all — not for your territory and not for anyone else's. Pick a different period.`
            : `No sales in ${figureLabel} were attributed to your DM seat${scope.dmSeatIds.length > 1 ? "s" : ""} in the ${ds.meta.line} line's canonical data. This may be a seat-mapping gap rather than an empty territory — please report it before drawing any conclusion.`
        }
        title={coverage.empty ? "No data in this period" : "Territory could not be matched"}
      />,
      `${figureLabel} for your territory, as ${access.role}.`,
      figureLabel,
    );
  }

  // One read, then narrowed to the areas this viewer actually holds. A failed read must not take
  // the page down with it: the achievement, spend and activity figures are all still correct, so
  // the panels are dropped and everything else renders.
  // The people this viewer may see: the ones whose own month-by-month attribution placed them in
  // one of HIS districts, and the managers who rode with a rep standing there (owner, 2026-10-20).
  // Never the line's people, which is what the deep tab showed before the 2026-09-26 line-scoping fix.
  const seatPeople = peopleInReviewView([
    { people: ds.people, view: { kind: "seats", seatIds: new Set(scope.dmSeatIds) } },
  ]);
  // A district pack. `narrowSelection` keeps catalogue order, so two people who tick the same
  // metrics get the same page in the same sequence.
  const metrics = requested == null
    ? defaultSelectionFor("district")
    : narrowSelection(requested, "district");

  // The customer-grain read happens ONLY when a metric that needs it is ticked. It is a round trip
  // per line per month, and a manager who untickled the brick, customer and channel metrics must not
  // pay for them. A failed read drops the panels and leaves the rest of the page correct —
  // achievement, spend and activity do not depend on it.
  let concentration: ConcentrationFacts | null = null;
  try {
    if (needsClosingDetail(metrics)) {
      // This district's line only: `byLine` for that line is all this reads (2026-10-01, speed).
      const detail = await loadReviewConcentration({ coverage, viewer: access, lines: [scope.line] });
      concentration = concentrationForAreas(
        detail.byLine[REVIEW_LINE_CODES[scope.line]] ?? [],
        areas.map((area) => area.areaCode),
      );
    }
  } catch {
    concentration = null;
  }

  return shell(
    <BusinessReviewPortal
      {...shared}
      scopeFilter={scopeFilterFor(metrics)}
      windowHidden={appliedParams}
      areas={areas.map(withAreaBand)}
      concentration={concentration}
      dms={dms.map(withDmBand)}
      people={seatPeople}
      metrics={metrics}
      picker={
        <PackPicker
          action="/employee-portals/business-review"
          hidden={carry}
          level="district"
          selected={metrics}
        />
      }
      spend={{
        marketing: dms.reduce((sum, d) => sum + d.marketingCost, 0),
        outstation: dms.reduce((sum, d) => sum + d.outstationCost, 0),
      }}
      headline={headline}
      keyProducts={keyProducts}
      lineRows={[]}
      months={ds.meta.months}
      productTables={[]}
      scopeLabel={scope.label}
      thresholds={ds.meta.thresholds}
      visitsAvailable={ds.visits.available}
    />,
    `${figureLabel} for your territory, as ${access.role}.`,
    figureLabel,
  );
}
