"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Download, FileSpreadsheet } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ReviewLine, ReviewView } from "@/lib/business-review/service";
import { REVIEW_VIEWS } from "@/lib/business-review/review-views";
import { figureWindowLabel, hasFigures, type ReviewCoverage } from "@/lib/business-review/coverage";
import {
  formatVisitCountSplit,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";
import { periodColumnLabel } from "@/lib/business-review/period-format";
import { columnPercents } from "@/lib/business-review/table-columns";
import type { ReviewWindow } from "@/lib/business-review/period";
import type { AreaSummary, DmSummary, ProductRow, ReviewCompany, ReviewDataset } from "@/lib/business-review/types";
import {
  CoverageBanner,
  CoverageTab,
  HardEmptyWindow,
  type CoverageProvenance,
} from "./coverage.client";
import { ReviewPeriodFilter } from "./review-filter.client";
import { PackPicker } from "./pack-picker.client";
import type { PackLevel, ReviewMetricId } from "@/lib/business-review/pack/metrics";
import { PortalDesktopTable, PortalResponsiveDataList } from "@/components/employee-portal/portal-primitives";
import { CustomersByAreaTable, PeopleActivityTable, RoleActivityTable } from "./rollups.client";
import { isResignedStatus } from "@/lib/business-review/employment-status";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";

type DmRow = DmSummary & { payoutPct: number; band: string; activePayoutPct: number; activeBand: string };
type AreaRow = AreaSummary & { payoutPct: number; band: string };
type LineTag = { line: string; lineId: ReviewLine };
type CoDmRow = DmRow & LineTag & { keyProducts: string[]; families: string[]; visitsAvailable: boolean };
type CoAreaRow = AreaRow & LineTag;
type Thresholds = { repFailBelow: number; dsmFailBelow: number };
type Shared = {
  viewerRole: string;
  company: ReviewCompany;
  restatementNotice: string;
  /** The window every figure on the page answers, and what the source data holds for it. */
  window: ReviewWindow;
  coverage: ReviewCoverage;
  provenance: CoverageProvenance;
  /** Months the filter may offer. Discovered from the data, never hardcoded. */
  available: string[];
  /** The export pack: which metric catalogue this view offers, and what is currently ticked. */
  packLevel: PackLevel;
  packMetrics: ReviewMetricId[];
  /** The region/district/area narrowing control, rendered in the header (admin page). */
  scopeFilter?: React.ReactNode;
  /** The applied narrowing as URL params, carried into the pack export so a scoped screen exports a
   *  scoped pack. Region and area may each be several. */
  exportParams?: Record<string, string | string[]>;
  /** True when a region/district/area narrowing is applied. The achievement, sales, target and spend
   *  tiles are exact for the narrowed set (area-summed); the customer/visit UNION tiles are not
   *  summable, so they defer to the per-row figures in the tables instead of printing a wrong total. */
  narrowed?: boolean;
  /** The subject's own name when narrowed — e.g. "CNS · Cairo region" — for the header. */
  scopeLabel?: string;
};
/** Discriminated on `view`: the company rollup consolidates every line's areas and DM
 * seats; a line view carries exactly one dataset. Keeps each branch free of null checks. */
type Props =
  | ({
      view: "company";
      companyDms: CoDmRow[];
      companyAreas: CoAreaRow[];
      companyProductTables: { id: ReviewLine; label: string; products: ProductRow[] }[];
      companyThresholds: Thresholds;
    } & Shared)
  | ({ view: ReviewLine; ds: ReviewDataset; dms: DmRow[]; areas: AreaRow[] } & Shared);

const egp = (n: number) =>
  stableCurrencyFormatter("en-US", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(Number.isFinite(n) ? n : 0);
const pct = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);
const num = (n: number | null | undefined) => (n != null && Number.isFinite(n) ? n.toLocaleString("en-US") : "0");
/** Renders "no data" instead of a misleading 0 when the source holds no rows for this
 *  window. A zero here would read as "nobody visited anybody", which is an accusation. */
const numOrNA = (n: number | null | undefined, available: boolean) => (available ? num(n) : "no data");
const egpOrNA = (n: number, available: boolean) => (available ? egp(n) : "no data");

/**
 * AM · PM · Pharmacies, in the house wording — the owner's golden rule, 2026-09-21.
 *
 * The separator is the middle dot and NEVER a slash, and a pharmacy is never folded into the PM
 * doctors however the vendor tagged its period. `formatVisitCountSplit` is the shared formatter, so
 * this page cannot drift from Private Calendar, Double Visit Analytics or Employee 360.
 */
const splitLabel = (split: VisitCountSplit) => formatVisitCountSplit(split);
/**
 * The same three figures for distinct CUSTOMERS rather than visits, judged by the visits they were
 * counted from: Phoenix CRM logs no pharmacy visit, so a team that works in it reads "Pharmacies not
 * recorded in Phoenix", never 0 (src/lib/crm/visit-count-buckets.ts, `fromVisits`).
 */
const customerSplitLabel = (c: {
  customersAm: number;
  customersPm: number;
  customersPharmacy: number;
  visitSplit?: VisitCountSplit;
  customerVisitSplit?: VisitCountSplit;
}) =>
  formatVisitCountSplit(
    { am: c.customersAm, pm: c.customersPm, pharmacies: c.customersPharmacy },
    { fromVisits: c.customerVisitSplit ?? c.visitSplit },
  );

function achColor(a: number | null) {
  if (a == null) return "text-muted-foreground";
  if (a >= 100) return "text-emerald-600";
  if (a >= 90) return "text-teal-600";
  if (a >= 70) return "text-amber-600";
  if (a >= 40) return "text-orange-600";
  return "text-red-600";
}
const achCell = (a: number | null) => <span className={cn("font-semibold tabular-nums", achColor(a))}>{pct(a)}</span>;

const BAND_STYLE: Record<string, string> = {
  elite: "bg-emerald-100 text-emerald-700",
  "over-achiever": "bg-teal-100 text-teal-700",
  "on-target": "bg-sky-100 text-sky-700",
  threshold: "bg-amber-100 text-amber-700",
  "not-eligible": "bg-muted text-muted-foreground",
};
const BAND_LABEL: Record<string, string> = {
  elite: "Elite 150%+", "over-achiever": "120–150%", "on-target": "100–120%", threshold: "90–100%", "not-eligible": "< 90%",
};
const Band = ({ band }: { band: string }) => (
  <span className={cn("rounded px-1.5 py-0.5 text-phx-2xs font-bold", BAND_STYLE[band] ?? BAND_STYLE["not-eligible"])}>{BAND_LABEL[band] ?? band}</span>
);

/** Rebuilt from canonical SoS, this review can show different bands than what H1 was
 * actually paid on. Every render of this dashboard carries this banner — see canonical.ts. */
function RestatementBanner({ notice }: { notice: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <p className="text-sm font-semibold text-amber-900">{notice}</p>
    </div>
  );
}

const TABS = [
  { id: "achievers", label: "Achievers" },
  { id: "fails", label: "Performance Gaps" },
  { id: "deep", label: "Deep Analysis" },
  { id: "coverage", label: "Coverage & Sources" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/**
 * THE ONE TABLE SHAPE ON THIS PAGE — desktop table, phone cards, and no sideways scroll.
 *
 * Owner's golden rule: "never a horizontal scroll, always mobile AND desktop friendly … fit by
 * MERGING columns, never shrinking type — `overflow-x-auto` over a `min-width` IS the bug." This
 * file held 22 tables in exactly that construct, the largest unretired cluster in the module.
 *
 * 🔴 Deleting the class was NOT the fix. `app/globals.css` gives ANY element in the admin shell
 * with a direct `<table>` child `overflow-x: auto`, whatever its class list says — deliberate, for
 * the components that render a bare table, and invisible to the ratchet, which only reads class
 * strings. So the fix has to make the overflow impossible BY CONSTRUCTION: `PortalDesktopTable` is
 * `w-full table-fixed` and takes a percentage `<colgroup>`, so the columns divide the container
 * and a long name wraps instead of pushing the table wide.
 *
 * Those two primitives are safe here despite their names: they carry no palette at all, and
 * rollups.client.tsx has been rendering through them inside this very dashboard for weeks. What is
 * NOT reused is PortalSection / PortalMetricCard, which do state portal colours — the admin chrome
 * (`Section`, `Kpi`) stays.
 *
 * Widths are sized against ~720px, the admin content box at a 1024px viewport (1024 − 272 sidebar
 * − 32 padding), not 1280. `breakpoint="lg"` for a grid that needs more than that.
 */
function ReviewTable<T>({
  breakpoint = "md",
  cols,
  empty,
  getKey,
  head,
  items,
  renderCard,
  renderRow,
}: {
  breakpoint?: "md" | "lg" | "xl";
  cols: React.ReactNode;
  empty: string;
  getKey: (item: T, index: number) => string;
  head: React.ReactNode;
  items: T[];
  renderCard: (item: T, index: number) => React.ReactNode;
  renderRow: (item: T, index: number) => React.ReactNode;
}) {
  return (
    <PortalResponsiveDataList
      breakpoint={breakpoint}
      empty={<p className={EMPTY_LINE}>{empty}</p>}
      getKey={getKey}
      items={items}
      renderCard={renderCard}
      renderTable={() => (
        <PortalDesktopTable breakpoint={breakpoint} cols={cols}>
          <thead>
            <tr className="border-b border-border">{head}</tr>
          </thead>
              <tbody>
            {items.map((item, i) => (
              <React.Fragment key={getKey(item, i)}>{renderRow(item, i)}</React.Fragment>
            ))}
          </tbody>
        </PortalDesktopTable>
      )}
    />
  );
}

/**
 * A `<colgroup>` for one of these tables. `fixed` is the leading columns' percentages; `fill` is
 * how many generated columns (one per month, one per product) divide what is left. The width is an
 * inline style rather than a `w-[n%]` class because Tailwind scans arbitrary values out of the
 * source text and would never generate a computed one.
 */
function Cols({ fill = 0, fixed }: { fill?: number; fixed: readonly number[] }) {
  return (
    <colgroup>
      {columnPercents(fixed, fill).map((width, i) => (
        <col key={i} style={{ width: `${width}%` }} />
      ))}
    </colgroup>
  );
}

/** One line of muted prose where a table would otherwise be empty. */
const EMPTY_LINE = "px-3 py-4 text-sm text-muted-foreground";
/** A phone card's title line. `break-words` because a district name has no natural break. */
const CARD_TITLE = "min-w-0 break-words text-sm font-bold";
const CARD_SUB = "mt-0.5 min-w-0 break-words text-phx-xs text-muted-foreground";
/** The small labelled figures under a card's title. */
function CardFields({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {items.map((f) => (
        <div className="border border-border bg-bg-muted px-2.5 py-2" key={f.label}>
          <dt className="text-phx-2xs font-bold uppercase tracking-[0.1em] text-muted-foreground">{f.label}</dt>
          <dd className="mt-0.5 min-w-0 break-words text-sm font-semibold">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Top switcher — All Company first, then each line. Server-rendered links so every
 * switch re-runs the page's role gate. */
function ViewSwitcher({ current, window }: { current: ReviewView; window: ReviewWindow }) {
  return (
    <nav className="flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1">
      {REVIEW_VIEWS.map((v) => (
        <Link key={v.id} href={`/business-review?line=${v.id}&from=${window.from}&to=${window.to}`}
          className={cn("rounded-md px-3 py-1.5 text-sm font-semibold transition-colors",
            current === v.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-bg-muted")}>
          {v.label}
        </Link>
      ))}
    </nav>
  );
}

/** Plain links, not fetch+blob: the browser streams the file straight from the route and
 * the server's own role gate is what authorises it. */
function ExportButtons({ view, window }: { view: ReviewView; window: ReviewWindow }) {
  const range = `from=${window.from}&to=${window.to}`;
  const base = "flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-muted-foreground transition-colors hover:bg-bg-muted hover:text-foreground";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a href={`/api/business-review/export?line=${view}&${range}&variant=summary`} className={base}
        title="One-page executive summary: headline numbers, line table and DSM ranking">
        <FileSpreadsheet className="size-4" aria-hidden />
        Summary
      </a>
      <a href={`/api/business-review/export?line=${view}&${range}`} className={base}
        title="Full workbook: every area, product, month and spend line">
        <Download className="size-4" aria-hidden />
        Full Excel
      </a>
    </div>
  );
}

function ReviewHeader({
  title,
  subtitle,
  current,
  window,
  available,
  packLevel,
  packMetrics,
  scopeFilter,
  exportParams,
  children,
}: {
  title: string;
  subtitle: string;
  current: ReviewView;
  window: ReviewWindow;
  available: string[];
  packLevel: PackLevel;
  packMetrics: ReviewMetricId[];
  scopeFilter?: React.ReactNode;
  exportParams?: Record<string, string | string[]>;
  children?: React.ReactNode;
}) {
  // The window and the current line ride every export and navigation; the applied region/area/district
  // narrowing rides the pack export too, so a scoped screen hands over a scoped pack.
  const base: Record<string, string | string[]> =
    current === "company" ? { from: window.from, to: window.to } : { from: window.from, line: current, to: window.to };
  const packHidden = { ...base, ...(exportParams ?? {}) };
  return (
    <header className="space-y-3 border-b border-border pb-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-phx-xs font-semibold uppercase tracking-[0.18em] text-primary">Business Review · Read-only</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{title}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ViewSwitcher current={current} window={window} />
          {children}
          <ExportButtons view={current} window={window} />
        </div>
      </div>
      {/* A GET form: applying a window is a real navigation, so the server role gate re-runs. */}
      <ReviewPeriodFilter
        action="/business-review"
        available={available}
        from={window.from}
        to={window.to}
        hidden={{ line: current, ...(exportParams ?? {}) }}
      />
      {/* Region / district / area narrowing (admin). It submits to this same page, carrying the window
          and the current line, so applying it re-runs the server role gate on the narrowed view. */}
      {scopeFilter}
      {/* The self-service export pack, the same one the employee portal offers. The pack link carries
          the current line AND the applied narrowing as a FILTER (hidden); the route resolves the SCOPE
          from the session, so a filter can only narrow, never widen, whatever a URL says. */}
      <PackPicker action="/business-review" hidden={packHidden} level={packLevel} selected={packMetrics} />
    </header>
  );
}

export function BusinessReviewDashboard(props: Props) {
  // A window with no sales renders NO tables. A page of zeros and a 0% company achievement is
  // the most misleading thing this module could put in front of a head of department.
  if (props.coverage.empty) {
    return (
      <div className="space-y-5">
        <ReviewHeader
          current={props.view}
          window={props.window}
          available={props.available}
          packLevel={props.packLevel}
          packMetrics={props.packMetrics}
          scopeFilter={props.scopeFilter}
          exportParams={props.exportParams}
          title={`Business Review — ${props.window.label}`}
          subtitle={`No data in this window · viewing as ${props.viewerRole}`}
        />
        <HardEmptyWindow coverage={props.coverage} available={props.available} />
      </div>
    );
  }
  if (props.view === "company") return <CompanyDashboard {...props} />;
  return <LineDashboard {...props} />;
}

function CompanyDashboard({
  company, viewerRole, companyDms, companyAreas, companyProductTables, companyThresholds, restatementNotice,
  window: reviewWindow, coverage, provenance, available, packLevel, packMetrics,
  scopeFilter, exportParams, narrowed = false, scopeLabel,
}: Extract<Props, { view: "company" }>) {
  const [tab, setTab] = useState<TabId>("achievers");
  const [excludeVacant, setExcludeVacant] = useState(false);
  const M = company.meta.months;
  const T = company.total;
  // Coverage decides whether a tile shows a number at all. Read it BEFORE the figure.
  const visitsOk = hasFigures(coverage, "visits");
  const customersOk = hasFigures(coverage, "customers");
  const marketingOk = hasFigures(coverage, "marketing");
  const outstationOk = hasFigures(coverage, "outstation");
  // A distinct-customer or visiting-rep total is a UNION, not a sum, so it cannot be recomputed for a
  // narrowed set from the area rows. Rather than print a whole-company figure under a filtered heading,
  // the tile points at the per-area rows in the table, which ARE the narrowed figures.
  const unionValue = (v: number | null | undefined, ok: boolean) => (narrowed ? "in the table" : numOrNA(v, ok));
  const unionSub = (s: string) => (narrowed ? "counted per area, below" : s);
  // The summable totals for the tiles. When narrowed they are recomputed EXACTLY from the shown areas
  // and districts — area-summed sales/target/graded is exact, and spend sums the shown districts.
  const ct = useMemo(() => {
    if (!narrowed) {
      return { ach: T.allProducts.ach, marketingCost: T.marketingCost, outstationCost: T.outstationCost, sales: T.allProducts.sales, target: T.allProducts.target };
    }
    const sales = companyAreas.reduce((s, a) => s + a.allProducts.sales, 0);
    const target = companyAreas.reduce((s, a) => s + a.allProducts.target, 0);
    const graded = companyAreas.reduce((s, a) => s + a.allProducts.graded, 0);
    return {
      ach: target > 0 ? (100 * graded) / target : null,
      marketingCost: companyDms.reduce((s, d) => s + d.marketingCost, 0),
      outstationCost: companyDms.reduce((s, d) => s + d.outstationCost, 0),
      sales,
      target,
    };
  }, [narrowed, companyAreas, companyDms, T]);

  const vDms = useMemo(() => (excludeVacant ? companyDms.filter((d) => !d.vacant) : companyDms), [companyDms, excludeVacant]);
  const vAreas = useMemo(() => (excludeVacant ? companyAreas.filter((a) => !a.vacant) : companyAreas), [companyAreas, excludeVacant]);
  const rankedDms = useMemo(
    () => [...vDms].sort((a, b) => (b.allProducts.ach ?? -1) - (a.allProducts.ach ?? -1)),
    [vDms],
  );

  return (
    <div className="space-y-5">
      <ReviewHeader
        current="company"
        window={reviewWindow}
        available={available}
        packLevel={packLevel}
        packMetrics={packMetrics}
        scopeFilter={scopeFilter}
        exportParams={exportParams}
        title={narrowed && scopeLabel ? `${scopeLabel} — ${figureWindowLabel(coverage)}` : `All Company — ${figureWindowLabel(coverage)}`}
        subtitle={narrowed ? `filtered view · ≥90% = earner · viewing as ${viewerRole}` : `${company.meta.lines.length} lines consolidated · ≥90% = earner · viewing as ${viewerRole}`}
      >
        <label className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2">
          <Switch checked={excludeVacant} onChange={setExcludeVacant} label="Hide vacant and resigned" />
          <span className="text-sm font-medium">Hide vacant and resigned</span>
        </label>
      </ReviewHeader>

      <RestatementBanner notice={restatementNotice} />
      <CoverageBanner coverage={coverage} />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label={narrowed ? "Achievement" : "Company achievement"} value={coverage.ungradeable ? "not gradeable" : pct(ct.ach)} sub={coverage.ungradeable ? "no targets loaded for this window" : `${narrowed ? "filtered scope" : "all 3 lines · all areas"} · ${figureWindowLabel(coverage)}, period to date`} accent={coverage.ungradeable ? undefined : achColor(ct.ach)} />
        <Kpi label="Sales (total)" value={egp(ct.sales)} sub={coverage.ungradeable ? "value only" : `of ${egp(ct.target)}`} />
        {/* "Customers", not "Doctors": one in seven of these is a pharmacy, and a pharmacy is never
            a doctor (owner golden rule). The three figures are reported apart, never joined by a
            slash, and PM is the only one that may be called doctors. */}
        <Kpi label="Customers reached" value={unionValue(T.customersTotal, customersOk)} sub={unionSub(customersOk ? customerSplitLabel(T) : "no CRM rows in this window")} />
        <Kpi label="Marketing + exp." value={marketingOk || outstationOk ? egp(ct.marketingCost + ct.outstationCost) : "no data"} sub={`${egpOrNA(ct.marketingCost, marketingOk)} + ${egpOrNA(ct.outstationCost, outstationOk)}`} />
        <Kpi label="Visits" value={unionValue(T.visits, visitsOk)} sub={unionSub(visitsOk ? splitLabel(T.visitSplit) : "no CRM rows in this window")} />
        {/* The denominator a visit count is actually per. This tile printed reps with SALES until
            2026-09-26 — 85 against the 122 who really visited, so visits-per-rep read 44% high. */}
        <Kpi label="Reps in the field" value={unionValue(T.visitingReps, visitsOk)} sub={unionSub(visitsOk ? `${num(T.doubleVisits)} double visits · ${num(T.reps)} reps carried sales` : "no CRM rows in this window")} />
      </section>

      {/* Two-up on a phone, one row from sm. Four `flex-1` buttons in a 359px row left 82px for
          "Performance Gaps", which needs 93 — measured at 375px, 2026-09-26. A grid wraps; `flex-1`
          on its own only ever shrinks, and the label was cut with nothing to scroll to reach it. */}
      <nav className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-card p-1 sm:flex">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} type="button"
            className={cn("min-w-0 rounded-md px-3 py-2 text-sm font-semibold transition-colors sm:flex-1", tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-bg-muted")}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "achievers" && <CompanyAchieversTab company={company} dms={rankedDms} areas={vAreas} />}
      {tab === "fails" && <CompanyFailsTab dms={rankedDms} areas={vAreas} thresholds={companyThresholds} />}
      {tab === "deep" && (
        <CompanyDeepTab
          company={company}
          dms={rankedDms}
          areas={vAreas}
          months={M}
          productTables={companyProductTables}
          customersOk={customersOk}
          people={excludeVacant ? company.people.filter((p) => !isResignedStatus(p.employmentStatus)) : company.people}
        />
      )}
      {tab === "coverage" && <CoverageTab coverage={coverage} provenance={provenance} />}
    </div>
  );
}

function LineDashboard({
  ds, dms, areas, viewerRole, view: currentLine, restatementNotice,
  window: reviewWindow, coverage, provenance, available, packLevel, packMetrics,
  scopeFilter, exportParams, narrowed = false, scopeLabel,
}: Extract<Props, { ds: ReviewDataset }>) {
  const [tab, setTab] = useState<TabId>("achievers");
  const [excludeVacant, setExcludeVacant] = useState(false);
  const M = ds.meta.months;
  const visitsOk = hasFigures(coverage, "visits");
  const customersOk = hasFigures(coverage, "customers");
  const marketingOk = hasFigures(coverage, "marketing");
  const outstationOk = hasFigures(coverage, "outstation");

  const vDms = useMemo(() => (excludeVacant ? dms.filter((d) => !d.vacant) : dms), [dms, excludeVacant]);
  const vAreas = useMemo(() => (excludeVacant ? areas.filter((a) => !a.vacant) : areas), [areas, excludeVacant]);
  // Achievement % is ALWAYS computed on all areas — vacancy never changes a number.
  // The Exclude-vacant toggle only hides vacant areas/DMs from the displayed lists.
  const line = ds.line.allProducts;
  const rankedDms = useMemo(
    () => vDms.filter((d) => d.allProducts.target > 0).sort((a, b) => (b.allProducts.ach ?? -1) - (a.allProducts.ach ?? -1)),
    [vDms],
  );
  // Per-line include list (4 for Pedia, all 15 for CNS) — drives the compact
  // per-product columns in Performance Gaps / Deep Analysis.
  const keyProducts = useMemo(() => ds.products.filter((p) => p.include).map((p) => p.product), [ds.products]);

  // When a region/district/area narrowing is applied, the achievement, sales, target and spend tiles
  // are EXACT for the narrowed set — summing area sales/target/graded is exact (the same method the
  // portal documents as agreeing with this page's headline), and spend sums the shown districts. The
  // customer/visit UNION tiles are not summable and defer to the per-area rows below.
  const nLine = useMemo(() => {
    if (!narrowed) return null;
    const sales = areas.reduce((s, a) => s + a.allProducts.sales, 0);
    const target = areas.reduce((s, a) => s + a.allProducts.target, 0);
    const graded = areas.reduce((s, a) => s + a.allProducts.graded, 0);
    return {
      ach: target > 0 ? (100 * graded) / target : null,
      marketingCost: dms.reduce((s, d) => s + d.marketingCost, 0),
      outstationApproved: dms.reduce((s, d) => s + d.outstationApproved, 0),
      outstationCost: dms.reduce((s, d) => s + d.outstationCost, 0),
      sales,
      target,
    };
  }, [narrowed, areas, dms]);
  const lt = nLine ?? {
    ach: line.ach,
    marketingCost: ds.line.marketingCost,
    outstationApproved: ds.line.outstationApproved,
    outstationCost: ds.line.outstationCost,
    sales: line.sales,
    target: line.target,
  };
  const unionValue = (v: number | null | undefined, ok: boolean) => (narrowed ? "in the table" : numOrNA(v, ok));
  const unionSub = (s: string) => (narrowed ? "counted per area, below" : s);

  return (
    <div className="space-y-5">
      <ReviewHeader
        current={currentLine}
        window={reviewWindow}
        available={available}
        packLevel={packLevel}
        packMetrics={packMetrics}
        scopeFilter={scopeFilter}
        exportParams={exportParams}
        title={narrowed && scopeLabel ? `${scopeLabel} — ${figureWindowLabel(coverage)}` : `${ds.meta.line} Line — ${figureWindowLabel(coverage)}`}
        subtitle={narrowed ? `filtered view · ≥90% = earner · viewing as ${viewerRole}` : `all products · ≥90% = earner · viewing as ${viewerRole}`}
      >
        <label className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2">
          <Switch checked={excludeVacant} onChange={setExcludeVacant} label="Hide vacant and resigned" />
          <span className="text-sm font-medium">Hide vacant and resigned</span>
        </label>
      </ReviewHeader>

      <RestatementBanner notice={restatementNotice} />
      <CoverageBanner coverage={coverage} />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Line achievement" value={lt.target > 0 ? pct(lt.ach) : "not gradeable"} sub={lt.target > 0 ? `${narrowed ? "filtered areas" : "all areas"} · all products · ${figureWindowLabel(coverage)}, period to date` : "no targets loaded for this window"} accent={lt.target > 0 ? achColor(lt.ach) : undefined} />
        <Kpi label="Sales (total)" value={egp(lt.sales)} sub={lt.target > 0 ? `of ${egp(lt.target)}` : "value only"} />
        <Kpi label="Customers reached" value={unionValue(ds.line.customersTotal, customersOk)} sub={unionSub(customersOk ? customerSplitLabel(ds.line) : "no CRM rows in this window")} />
        <Kpi label="Marketing cost" value={egpOrNA(lt.marketingCost, marketingOk)} sub={marketingOk ? "committed only" : "no requests in this window"} />
        <Kpi label="Outstation exp." value={egpOrNA(lt.outstationCost, outstationOk)} sub={outstationOk ? `${egp(lt.outstationApproved)} HR-approved` : "no claims in this window"} />
        <Kpi label="Visits / rep / mo" value={unionValue(ds.line.visitsAvgPerRepPerMonth, visitsOk)} sub={unionSub(visitsOk ? `${num(ds.line.visits)} total · ${num(ds.line.visitingReps)} reps` : "no CRM rows in this window")} />
      </section>

      {/* The three figures apart, at line level. Never joined by a slash — the separator is the
          middle dot, and a pharmacy call is never counted among the PM doctors. */}
      {visitsOk && !narrowed && (
        <p className="text-phx-xs text-muted-foreground">
          Visits {splitLabel(ds.line.visitSplit)} · customers {customerSplitLabel(ds.line)}
        </p>
      )}

      {/* Two-up on a phone, one row from sm. Four `flex-1` buttons in a 359px row left 82px for
          "Performance Gaps", which needs 93 — measured at 375px, 2026-09-26. A grid wraps; `flex-1`
          on its own only ever shrinks, and the label was cut with nothing to scroll to reach it. */}
      <nav className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-card p-1 sm:flex">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} type="button"
            className={cn("min-w-0 rounded-md px-3 py-2 text-sm font-semibold transition-colors sm:flex-1", tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-bg-muted")}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "achievers" && <AchieversTab dms={rankedDms} areas={vAreas} visitsAvailable={visitsOk} />}
      {tab === "fails" && <FailsTab dms={rankedDms} areas={vAreas} thresholds={ds.meta.thresholds} keyProducts={keyProducts} />}
      {tab === "deep" && (
        <DeepTab
          ds={ds}
          dms={rankedDms}
          areas={vAreas}
          months={M}
          keyProducts={keyProducts}
          customersOk={customersOk}
          roles={ds.roles}
          people={excludeVacant ? ds.people.filter((p) => !isResignedStatus(p.employmentStatus)) : ds.people}
        />
      )}
      {tab === "coverage" && <CoverageTab coverage={coverage} provenance={provenance} />}
    </div>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <p className="text-phx-2xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={cn("mt-1.5 text-xl font-bold tabular-nums", accent)}>{value}</p>
      {sub && <p className="mt-0.5 text-phx-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      {/* `flex-wrap` and `min-w-0`: without them a title and a note share one non-wrapping row,
          and at 375px "Company monthly trend" was given 36px of the 62 it needs. The no-ellipsis
          rule means the answer is to wrap, never to truncate. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <h2 className="min-w-0 break-words text-sm font-bold">{title}</h2>
        {note && <span className="min-w-0 break-words text-xs text-muted-foreground">{note}</span>}
      </div>
      {/* No scroll wrapper — see ReviewTable. Removing the class is not by itself the fix in the
          admin shell, which grants overflow-x to any element with a direct <table> child; the fix
          is that nothing inside is wide any more. */}
      <div className="p-1">{children}</div>
    </div>
  );
}
const TH = "px-3 py-2 text-left text-phx-xs font-bold uppercase tracking-wide text-muted-foreground";
const THR = "px-3 py-2 text-right text-phx-xs font-bold uppercase tracking-wide text-muted-foreground";
const TD = "px-3 py-2 text-sm";
const TDR = "px-3 py-2 text-sm text-right tabular-nums";

/** "Lacto Advanced" is the only product name long enough to distort a column. */
const shortProduct = (p: string) => p.replace("Lacto Advanced", "Lacto");

/**
 * The per-product achievements as ONE wrapped cell.
 *
 * CNS carries fifteen include products. Fifteen columns cannot be read inside a 720px admin
 * content box, and they cannot be narrowed without shrinking type, which the fits-the-screen
 * golden rule forbids ahead of everything else — so the rule's own answer applies: MERGE them.
 * Every figure is still here, each one named, wrapping inside a single column.
 */
function ProductAchList({ products, slices }: { products: string[]; slices: Record<string, { ach: number | null }> | undefined }) {
  if (products.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {products.map((p) => (
        <span className="min-w-0 break-words text-phx-xs" key={p}>
          <span className="text-muted-foreground">{shortProduct(p)}</span> {achCell(slices?.[p]?.ach ?? null)}
        </span>
      ))}
    </span>
  );
}

function AchieversTab({ dms, areas, visitsAvailable }: { dms: DmRow[]; areas: AreaRow[]; visitsAvailable: boolean }) {
  // Vacant areas never count as earners — no rep held the territory, so residual
  // pharmacy-stock sales aren't an earned achievement. Mirrors how FailsTab excludes
  // vacant areas from failures and lists them separately as uncovered territory.
  const earners = areas.filter((a) => !a.vacant && a.hasTarget && (a.allProducts.ach ?? 0) >= 90).sort((a, b) => (b.allProducts.ach ?? 0) - (a.allProducts.ach ?? 0));
  return (
    <div className="space-y-4">
      <Section title="DSM league table" note="all-products achievement → 2026 payout (90% = threshold) · period to date — not a settled semester payout">
        {/* Ten columns merged to seven: the band rides under its own achievement, marketing and
            expenses share one Spend cell, and doubles ride under the visit rate. */}
        <ReviewTable
          breakpoint="lg"
          cols={<Cols fixed={[5, 23, 15, 10, 16, 13, 18]} />}
          empty="No district carried a target in this view."
          getKey={(d) => d.dmSeatId ?? d.dm}
          head={
            <>
              <th className={TH}>#</th>
              <th className={TH}>DSM</th>
              <th className={TH}>Achievement</th>
              <th className={THR}>Payout</th>
              <th className={THR}>Spend</th>
              <th className={THR}>Visits/mo</th>
              <th className={THR}>AM · PM · Pharmacies</th>
            </>
          }
          items={dms}
          renderCard={(d, i) => (
            <div className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className={CARD_TITLE}>
                    {i + 1}. {d.dm}
                    {d.vacant && <span className="ml-2 bg-bg-muted px-1.5 py-0.5 text-phx-2xs font-bold text-muted-foreground">VACANT</span>}
                  </h3>
                  <p className={CARD_SUB}>Customers {visitsAvailable ? customerSplitLabel(d) : "no data"}</p>
                </div>
                <div className="shrink-0 text-right">
                  {achCell(d.allProducts.ach)}
                  <p className="mt-1"><Band band={d.band} /></p>
                </div>
              </div>
              <CardFields
                items={[
                  { label: "Payout", value: d.payoutPct > 0 ? `${d.payoutPct.toFixed(0)}%` : "—" },
                  { label: "Marketing", value: egp(d.marketingCost) },
                  { label: "Expenses", value: egp(d.outstationCost) },
                  { label: "Visits/mo", value: numOrNA(d.visitsAvgPerMonth, visitsAvailable) },
                  { label: "Doubles", value: numOrNA(d.doubleVisits, visitsAvailable) },
                ]}
              />
            </div>
          )}
          renderRow={(d, i) => (
            <tr className={cn("border-b border-border/60 last:border-0", (d.allProducts.ach ?? 0) >= 90 && "bg-emerald-50/40")}>
              <td className={cn(TD, "text-muted-foreground")}>{i + 1}</td>
              <td className={cn(TD, "break-words font-semibold")}>
                {d.dm}
                {d.vacant && <span className="ml-2 bg-bg-muted px-1.5 py-0.5 text-phx-2xs font-bold text-muted-foreground">VACANT</span>}
              </td>
              <td className={TD}>
                {achCell(d.allProducts.ach)}
                <span className="mt-1 block"><Band band={d.band} /></span>
              </td>
              <td className={cn(TDR, "font-semibold")}>{d.payoutPct > 0 ? `${d.payoutPct.toFixed(0)}%` : "—"}</td>
              <td className={cn(TDR, "text-muted-foreground")}>
                {egp(d.marketingCost)}
                <span className="block">{egp(d.outstationCost)} exp.</span>
              </td>
              <td className={TDR}>
                {numOrNA(d.visitsAvgPerMonth, visitsAvailable)}
                <span className="block text-muted-foreground">{numOrNA(d.doubleVisits, visitsAvailable)} doubles</span>
              </td>
              <td className={cn(TDR, "break-words")}>{visitsAvailable ? customerSplitLabel(d) : "no data"}</td>
            </tr>
          )}
        />
      </Section>

      <Section title={`Incentive earners — areas ≥ 90% (${earners.length})`} note="threshold to unlock payout · period to date — not a settled semester payout">
        <ReviewTable
          cols={<Cols fixed={[32, 28, 22, 18]} />}
          empty="No area reached the 90% threshold in this view."
          getKey={(a) => a.areaCode ?? a.area}
          head={
            <>
              <th className={TH}>Area</th>
              <th className={TH}>DSM</th>
              <th className={TH}>Achievement</th>
              <th className={THR}>Payout</th>
            </>
          }
          items={earners}
          renderCard={(a) => (
            <div className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className={CARD_TITLE}>{a.area}</h3>
                  <p className={CARD_SUB}>{a.dm}</p>
                </div>
                <div className="shrink-0 text-right">
                  {achCell(a.allProducts.ach)}
                  <p className="mt-1"><Band band={a.band} /></p>
                </div>
              </div>
              <CardFields items={[{ label: "Payout", value: `${a.payoutPct.toFixed(0)}%` }]} />
            </div>
          )}
          renderRow={(a) => (
            <tr className="border-b border-border/60 last:border-0">
              <td className={cn(TD, "break-words font-semibold")}>{a.area}</td>
              <td className={cn(TD, "break-words text-muted-foreground")}>{a.dm}</td>
              <td className={TD}>
                {achCell(a.allProducts.ach)}
                <span className="mt-1 block"><Band band={a.band} /></span>
              </td>
              <td className={cn(TDR, "font-semibold")}>{a.payoutPct.toFixed(0)}%</td>
            </tr>
          )}
        />
      </Section>
    </div>
  );
}

function FailsTab({ dms, areas, thresholds, keyProducts }: { dms: DmRow[]; areas: AreaRow[]; thresholds: { repFailBelow: number; dsmFailBelow: number }; keyProducts: string[] }) {
  // Vacant areas are NEVER failures — always excluded from the fail lists and shown
  // separately as uncovered territory (visible only when vacant rows aren't toggled off).
  const failDms = dms.filter((d) => !d.vacant && (d.allProducts.ach ?? 999) < thresholds.dsmFailBelow);
  const failAreas = areas.filter((a) => !a.vacant && a.hasTarget && (a.allProducts.ach ?? 999) < thresholds.repFailBelow).sort((a, b) => (a.allProducts.ach ?? 0) - (b.allProducts.ach ?? 0));
  const uncovered = areas.filter((a) => a.vacant).sort((a, b) => (a.allProducts.ach ?? 0) - (b.allProducts.ach ?? 0));
  const ungrade = areas.filter((a) => a.ungradeable && !a.vacant);
  const prods = keyProducts;
  return (
    <div className="space-y-4">
      <Section title={`DSMs below ${thresholds.dsmFailBelow}% (${failDms.length})`}>
        <ReviewTable
          cols={<Cols fixed={[34, 22, 22, 22]} />}
          empty="No DSM below threshold in this view."
          getKey={(d) => d.dmSeatId ?? d.dm}
          head={
            <>
              <th className={TH}>DSM</th>
              <th className={TH}>Achievement</th>
              <th className={THR}>Sales</th>
              <th className={THR}>Target</th>
            </>
          }
          items={failDms}
          renderCard={(d) => (
            <div className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <h3 className={CARD_TITLE}>{d.dm}</h3>
                <span className="shrink-0">{achCell(d.allProducts.ach)}</span>
              </div>
              <CardFields
                items={[
                  { label: "Sales", value: egp(d.allProducts.sales) },
                  { label: "Target", value: egp(d.allProducts.target) },
                ]}
              />
            </div>
          )}
          renderRow={(d) => (
            <tr className="border-b border-border/60 last:border-0">
              <td className={cn(TD, "break-words font-semibold")}>{d.dm}</td>
              <td className={TD}>{achCell(d.allProducts.ach)}</td>
              <td className={cn(TDR, "text-muted-foreground")}>{egp(d.allProducts.sales)}</td>
              <td className={cn(TDR, "text-muted-foreground")}>{egp(d.allProducts.target)}</td>
            </tr>
          )}
        />
      </Section>

      <Section title={`Rep areas below ${thresholds.repFailBelow}% (${failAreas.length})`} note="per-product achievement + trend">
        {/* One column per include product would be fifteen on CNS. Merged — see ProductAchList. */}
        <ReviewTable
          breakpoint="lg"
          cols={<Cols fixed={[22, 18, 12, 40, 8]} />}
          empty="No rep area below threshold in this view."
          getKey={(a) => a.areaCode ?? a.area}
          head={
            <>
              <th className={TH}>Area</th>
              <th className={TH}>DSM</th>
              <th className={TH}>Total</th>
              <th className={TH}>Per product</th>
              <th className={TH}>Flag</th>
            </>
          }
          items={failAreas}
          renderCard={(a) => (
            <div className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className={CARD_TITLE}>{a.area}</h3>
                  <p className={CARD_SUB}>{a.dm}</p>
                </div>
                <div className="shrink-0 text-right">
                  {achCell(a.allProducts.ach)}
                  {a.hasReturns && <p className="mt-1 bg-red-100 px-1.5 py-0.5 text-phx-2xs font-bold text-red-600">RETURNS</p>}
                </div>
              </div>
              <div className="mt-2">
                <ProductAchList products={prods} slices={a.products} />
              </div>
            </div>
          )}
          renderRow={(a) => (
            <tr className="border-b border-border/60 last:border-0">
              <td className={cn(TD, "break-words font-semibold")}>{a.area}</td>
              <td className={cn(TD, "break-words text-xs text-muted-foreground")}>{a.dm}</td>
              <td className={TD}>{achCell(a.allProducts.ach)}</td>
              <td className={TD}>
                <ProductAchList products={prods} slices={a.products} />
              </td>
              <td className={TD}>
                {a.hasReturns ? <span className="bg-red-100 px-1.5 py-0.5 text-phx-2xs font-bold text-red-600">RETURNS</span> : ""}
              </td>
            </tr>
          )}
        />
      </Section>

      {uncovered.length > 0 && (
        <Section title={`Uncovered areas — vacant, no rep (${uncovered.length})`} note="excluded from failures · coverage gap, not a rep failure">
          <ReviewTable
            cols={<Cols fixed={[44, 34, 22]} />}
            empty="Every area in this view has a rep."
            getKey={(a) => a.areaCode ?? a.area}
            head={
              <>
                <th className={TH}>Area</th>
                <th className={TH}>DSM</th>
                <th className={THR}>Achievement</th>
              </>
            }
            items={uncovered}
            renderCard={(a) => (
              <div className="flex items-start justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0">
                  <h3 className={CARD_TITLE}>{a.area}</h3>
                  <p className={CARD_SUB}>{a.dm}</p>
                </div>
                <span className="shrink-0">{achCell(a.allProducts.ach)}</span>
              </div>
            )}
            renderRow={(a) => (
              <tr className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "break-words font-semibold")}>{a.area}</td>
                <td className={cn(TD, "break-words text-muted-foreground")}>{a.dm}</td>
                <td className={TDR}>{achCell(a.allProducts.ach)}</td>
              </tr>
            )}
          />
        </Section>
      )}

      {ungrade.length > 0 && (
        <Section title={`Ungradeable — sales but no target (${ungrade.length})`} note="target-setting gap, not a failure">
          <ReviewTable
            cols={<Cols fixed={[40, 34, 26]} />}
            empty="Every area with sales in this view carries a target."
            getKey={(a) => a.areaCode ?? a.area}
            head={
              <>
                <th className={TH}>Area</th>
                <th className={TH}>DSM</th>
                <th className={THR}>Sales (no target)</th>
              </>
            }
            items={ungrade}
            renderCard={(a) => (
              <div className="flex items-start justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0">
                  <h3 className={CARD_TITLE}>{a.area}</h3>
                  <p className={CARD_SUB}>{a.dm}</p>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums">{egp(a.allProducts.sales)}</span>
              </div>
            )}
            renderRow={(a) => (
              <tr className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "break-words font-semibold")}>{a.area}</td>
                <td className={cn(TD, "break-words text-muted-foreground")}>{a.dm}</td>
                <td className={TDR}>{egp(a.allProducts.sales)}</td>
              </tr>
            )}
          />
        </Section>
      )}
    </div>
  );
}

/** One row of a month grid: a metric, its figure per month, and optionally a window total. */
type MonthGridRow = {
  key: string;
  kind: "ach" | "num";
  label: React.ReactNode;
  total?: number | null;
  values: (number | null)[];
};
const monthCell = (v: number | null, kind: "ach" | "num") => (kind === "ach" ? achCell(v) : num(v));

/**
 * THE MONTH GRID — a metric per row, a month per column, and phone cards below the breakpoint.
 *
 * The window is the owner's to choose, so the column count is the data's: three months today, a
 * year if he picks one. Nothing here can be merged — a month is a month — so the fit comes from
 * `table-fixed` dividing the container by `Cols`, and from the phone getting a card per metric
 * with its months wrapped inside it rather than a grid it would have to drag sideways.
 */
function MonthGridTable({
  breakpoint = "md",
  empty,
  firstHead,
  months,
  rows,
  totalHead,
}: {
  breakpoint?: "md" | "lg" | "xl";
  empty: string;
  firstHead: string;
  months: string[];
  rows: MonthGridRow[];
  totalHead?: string;
}) {
  return (
    <ReviewTable
      breakpoint={breakpoint}
      cols={<Cols fill={months.length + (totalHead ? 1 : 0)} fixed={[totalHead ? 24 : 26]} />}
      empty={empty}
      getKey={(r) => r.key}
      head={
        <>
          <th className={TH}>{firstHead}</th>
          {months.map((m) => (
            <th className={THR} key={m}>
              {periodColumnLabel(m, months)}
            </th>
          ))}
          {totalHead && <th className={THR}>{totalHead}</th>}
        </>
      }
      items={rows}
      renderCard={(r) => (
        <div className="px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <h3 className={CARD_TITLE}>{r.label}</h3>
            {totalHead && <span className="shrink-0 text-sm font-bold tabular-nums">{monthCell(r.total ?? null, r.kind)}</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {months.map((m, i) => (
              <span className="min-w-0 text-phx-xs" key={m}>
                <span className="text-muted-foreground">{periodColumnLabel(m, months)}</span>{" "}
                {monthCell(r.values[i] ?? null, r.kind)}
              </span>
            ))}
          </div>
        </div>
      )}
      renderRow={(r) => (
        <tr className="border-b border-border/50 last:border-0">
          <td className={cn(TD, "break-words font-medium text-muted-foreground")}>{r.label}</td>
          {months.map((m, i) => (
            <td className={TDR} key={m}>
              {monthCell(r.values[i] ?? null, r.kind)}
            </td>
          ))}
          {totalHead && <td className={cn(TDR, "font-bold")}>{monthCell(r.total ?? null, r.kind)}</td>}
        </tr>
      )}
    />
  );
}

/** The mix panel beside a district's month grid — one row per family, or per include product. */
function DmMixTable({
  families,
  keyProducts,
  mix,
  mixByFamily,
}: {
  families: FamilyRow[];
  keyProducts: string[];
  mix: { familyAch?: Record<string, number | null>; productAch?: Record<string, number | null> };
  mixByFamily: boolean;
}) {
  const rows = mixByFamily
    ? families.map((f) => ({ ach: mix.familyAch?.[f.family] ?? null, key: f.family, label: `${f.family.trim()} (${f.skuCount})` }))
    : keyProducts.map((p) => ({ ach: mix.productAch?.[p] ?? null, key: p, label: p }));
  return (
    <ReviewTable
      cols={<Cols fixed={[62, 38]} />}
      empty="No mix to show for this district."
      getKey={(r) => r.key}
      head={
        <>
          <th className={TH}>{mixByFamily ? "Family mix" : "Product mix"}</th>
          <th className={THR}>Achievement</th>
        </>
      }
      items={rows}
      renderCard={(r) => (
        <div className="flex items-start justify-between gap-3 px-4 py-3">
          <span className="min-w-0 break-words text-sm font-medium">{r.label}</span>
          <span className="shrink-0">{achCell(r.ach)}</span>
        </div>
      )}
      renderRow={(r) => (
        <tr className="border-b border-border/50 last:border-0">
          <td className={cn(TD, "break-words font-medium")}>{r.label}</td>
          <td className={TDR}>{achCell(r.ach)}</td>
        </tr>
      )}
    />
  );
}

type FamilyRow = { family: string; skuCount: number; byMonth: Record<string, number | null>; total: number | null };

/** Rolls per-SKU sales/target up to family level (e.g. CNS's 15 SKUs -> 5 families:
 * Tebofortin, Conviban, Rispadex, Dopaminect, Dolabactin) so families can be compared
 * head-to-head instead of scanning every individual pack size. Only sums `include`
 * SKUs — for lines like Pedia where a family mixes included and excluded products
 * (e.g. Lacto Advanced 1/2 vs Lacto LF), summing everything would blend cross-line
 * noise into what's supposed to be an incentive-relevant comparison. A family with
 * zero included SKUs (Pedia's Tebofortin, entirely excluded there) is dropped. */
function familyRowsOf(ds: ReviewDataset): FamilyRow[] {
  const months = ds.meta.months;
  const acc = new Map<string, { skuCount: number; covered: Record<string, number>; target: Record<string, number>; totalCovered: number; totalTarget: number }>();
  for (const p of ds.products) {
    if (!p.include) continue;
    const f = acc.get(p.family) ?? { skuCount: 0, covered: {}, target: {}, totalCovered: 0, totalTarget: 0 };
    f.skuCount += 1;
    for (const m of months) {
      f.covered[m] = (f.covered[m] ?? 0) + (p.byMonth[m]?.graded ?? 0);
      f.target[m] = (f.target[m] ?? 0) + (p.byMonth[m]?.target ?? 0);
    }
    f.totalCovered += p.total.graded;
    f.totalTarget += p.total.target;
    acc.set(p.family, f);
  }
  // sum(covered)/sum(target). A SKU with sales and no target is real money and appears in the
  // value columns, but it must not lift the family percentage — see the Slice doc comment.
  const ach = (covered: number, target: number) => (target > 0 ? (100 * covered) / target : null);
  return Array.from(acc.entries())
    .map(([family, f]) => ({
      family,
      skuCount: f.skuCount,
      byMonth: Object.fromEntries(months.map((m) => [m, ach(f.covered[m] ?? 0, f.target[m] ?? 0)])),
      total: ach(f.totalCovered, f.totalTarget),
    }))
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
}

function DeepTab({
  ds, dms, areas, months, keyProducts, customersOk, roles, people,
}: {
  ds: ReviewDataset;
  dms: DmRow[];
  areas: AreaRow[];
  months: string[];
  keyProducts: string[];
  customersOk: boolean;
  roles: ReviewCompany["roles"];
  people: ReviewCompany["people"];
}) {
  const families = familyRowsOf(ds);
  // Family views only earn their place when families genuinely collapse the SKU list
  // (CNS 15 SKUs -> 5 families; Pedia 4 -> 3, collapsing Lacto Advanced 1+2). On a
  // line where families are 1:1 with products (Anti-Infective: 2 SKUs, 2 families) the
  // family table would be a row-for-row duplicate of the product table, so suppress it.
  const mixByFamily = families.length > 1 && families.length < keyProducts.length;
  return (
    <div className="space-y-4">
      {/* Per-DSM deep dives */}
      {dms.map((d) => (
        <div key={d.dmSeatId ?? d.dm} className="rounded-xl border border-border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-bold">{d.dm}</h2>
              <span className={cn("text-lg font-bold", achColor(d.allProducts.ach))}>{pct(d.allProducts.ach)}</span>
              <Band band={d.band} />
              {d.vacant && <span className="rounded bg-bg-muted px-1.5 py-0.5 text-phx-2xs font-bold text-muted-foreground">VACANT</span>}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>Payout <b className="text-foreground">{d.payoutPct.toFixed(0)}%</b></span>
              <span>Mktg <b className="text-foreground">{egp(d.marketingCost)}</b> ({d.marketingMonths}mo)</span>
              <span>Exp <b className="text-foreground">{egp(d.outstationCost)}</b></span>
              <span>Customers <b className="text-foreground">{ds.visits.available ? customerSplitLabel(d) : "no data"}</b></span>
              <span>Doubles <b className="text-foreground">{numOrNA(d.doubleVisits, ds.visits.available)}</b></span>
            </div>
          </div>
          {/* `min-w-0` on both halves: a grid item's default `min-width: auto` is the one thing
              that still pushes a `table-fixed` table past its container. */}
          <div className="grid gap-3 p-3 lg:grid-cols-[1.6fr_1fr]">
            <div className="min-w-0">
              <MonthGridTable
                empty="No month in this window carries a figure for this district."
                firstHead="Monthly"
                months={months}
                rows={[
                  { key: "ach", kind: "ach", label: "Achievement", values: months.map((m) => d.achByMonth?.[m] ?? null) },
                  ...(ds.visits.available
                    ? [
                        { key: "visits", kind: "num" as const, label: "Visits", values: months.map((m) => d.visitsByMonth?.[m] ?? 0) },
                        { key: "customers", kind: "num" as const, label: "Customers", values: months.map((m) => d.customersByMonth?.[m] ?? 0) },
                      ]
                    : []),
                ]}
              />
            </div>
            <div className="min-w-0">
              <DmMixTable families={families} keyProducts={keyProducts} mix={d} mixByFamily={mixByFamily} />
            </div>
          </div>
        </div>
      ))}

      {mixByFamily && (
        <Section title="Achievement per product family per month" note="rolled up across each family's include-eligible SKUs">
          <MonthGridTable
            empty="No family carried an include SKU in this window."
            firstHead="Family"
            months={months}
            rows={families.map((f) => ({
              key: f.family,
              kind: "ach" as const,
              label: `${f.family.trim()} (${f.skuCount} SKU${f.skuCount === 1 ? "" : "s"})`,
              total: f.total,
              values: months.map((m) => f.byMonth[m] ?? null),
            }))}
            totalHead="Total"
          />
        </Section>
      )}

      <Section title="Achievement per product per month" note="★ include products">
        <MonthGridTable
          empty="No product carried sales or a target in this window."
          firstHead="Product"
          months={months}
          rows={ds.products
            .filter((p) => p.total.target > 0 || p.total.sales > 0)
            .map((p) => ({
              key: p.product,
              kind: "ach" as const,
              label: (
                <>
                  {p.include && <span className="mr-1 text-amber-500">★</span>}
                  {p.product}
                </>
              ),
              total: p.total.ach,
              values: months.map((m) => p.byMonth[m]?.ach ?? null),
            }))}
          totalHead="Total"
        />
      </Section>

      <Section title="Line trend" note={ds.visits.available ? `${num(ds.visits.totalDeduped)} visits · ${num(ds.line.customersTotal)} doctors` : "no CRM visit rows in this window"}>
        <MonthGridTable
          empty="No month in this window carries a figure for this line."
          firstHead="Metric"
          months={months}
          rows={[
            { key: "ach", kind: "ach" as const, label: "Sales achievement", values: months.map((m) => ds.line.byMonth[m]?.allProducts.ach ?? null) },
            { key: "value", kind: "num" as const, label: "Sales value", values: months.map((m) => ds.line.byMonth[m]?.allProducts.sales ?? 0) },
            ...(ds.visits.available
              ? [
                  { key: "visits", kind: "num" as const, label: "Visits", values: months.map((m) => ds.visits.byMonth[m] ?? 0) },
                  { key: "customers", kind: "num" as const, label: "Customers reached", values: months.map((m) => ds.line.customersByMonth[m] ?? 0) },
                ]
              : []),
          ]}
        />
      </Section>

      {/* The question the owner asked for by name: how many customers did this area have,
          month by month. A union per month, never a sum across the reps who share the area. */}
      <CustomersByAreaTable
        areas={areas.map((a) => ({
          area: a.area,
          dm: a.dm,
          vacant: a.vacant,
          customersTotal: a.customersTotal,
          customersByMonth: a.customersByMonth,
          customersAm: a.customersAm,
          customersPm: a.customersPm,
          customersPharmacy: a.customersPharmacy,
          visitSplit: a.visitSplit,
        }))}
        months={months}
        visitsAvailable={customersOk}
      />

      {/* This line's own people — not the company's. Captioned either way, because two tables
          with identical headings and different scopes is how the old defect read as correct. */}
      <RoleActivityTable roles={roles} scopeNote={`${ds.meta.line} line only`} />
      <PeopleActivityTable people={people} scopeNote={`${ds.meta.line} line only`} />
    </div>
  );
}

const LineChip = ({ line }: { line: string }) => (
  <span className="rounded bg-bg-muted px-1.5 py-0.5 text-phx-2xs font-semibold text-muted-foreground">{line}</span>
);

function CompanyAchieversTab({ company, dms, areas }: { company: ReviewCompany; dms: CoDmRow[]; areas: CoAreaRow[] }) {
  const T = company.total;
  // Same rule as a line view: vacant areas never count as earners.
  const earners = areas
    .filter((a) => !a.vacant && a.hasTarget && (a.allProducts.ach ?? 0) >= 90)
    .sort((a, b) => (b.allProducts.ach ?? 0) - (a.allProducts.ach ?? 0));
  // Each line, then the company itself as a final row. One shape, so the totals line cannot
  // drift from the lines above it and the phone card list ends with it rather than losing it.
  const lineRows = [
    ...company.lines.map((l) => ({
      ach: l.allProducts.ach,
      dms: l.dms,
      dmsVacant: l.dmsVacant,
      earners: l.earners,
      exVacantAch: l.exVacant.ach,
      expenses: l.outstationCost,
      href: `/business-review?line=${l.id}`,
      isCompany: false,
      key: l.id,
      label: l.label,
      marketing: l.marketingCost,
      sales: l.allProducts.sales,
      target: l.allProducts.target,
    })),
    {
      ach: T.allProducts.ach,
      dms: company.lines.reduce((sum, l) => sum + l.dms, 0),
      dmsVacant: company.lines.reduce((sum, l) => sum + l.dmsVacant, 0),
      earners: company.lines.reduce((sum, l) => sum + l.earners, 0),
      exVacantAch: T.exVacant.ach,
      expenses: T.outstationCost,
      href: null as string | null,
      isCompany: true,
      key: "company",
      label: "Company",
      marketing: T.marketingCost,
      sales: T.allProducts.sales,
      target: T.allProducts.target,
    },
  ];
  return (
    <div className="space-y-4">
      <Section title="Line comparison" note="ranked by achievement · sum(sales)/sum(target), never an average of percentages">
        {/* Nine columns merged to six — the excl.-vacant achievement rides under the headline
            one, the target under its own sales, and marketing and expenses share a Spend cell.
            The Company row is the LAST item rather than a `tfoot`, so the phone gets it too. */}
        <ReviewTable
          cols={<Cols fixed={[20, 16, 18, 18, 12, 16]} />}
          empty="No line carried sales in this window."
          getKey={(r) => r.key}
          head={
            <>
              <th className={TH}>Line</th>
              <th className={TH}>Achievement</th>
              <th className={THR}>Sales</th>
              <th className={THR}>Spend</th>
              <th className={THR}>Earners</th>
              <th className={THR}>DM seats</th>
            </>
          }
          items={lineRows}
          renderCard={(r) => (
            <div className={cn("px-4 py-3.5", r.isCompany && "bg-bg-muted/40")}>
              <div className="flex items-start justify-between gap-3">
                <h3 className={CARD_TITLE}>{r.label}</h3>
                <div className="shrink-0 text-right">
                  {achCell(r.ach)}
                  <p className={CARD_SUB}>{pct(r.exVacantAch)} excl. vacant</p>
                </div>
              </div>
              <CardFields
                items={[
                  { label: "Sales", value: egp(r.sales) },
                  { label: "Target", value: egp(r.target) },
                  { label: "Marketing", value: egp(r.marketing) },
                  { label: "Expenses", value: egp(r.expenses) },
                  { label: "Earners", value: num(r.earners) },
                  { label: "DM seats", value: `${num(r.dms)}${r.dmsVacant > 0 ? ` +${r.dmsVacant} vac` : ""}` },
                ]}
              />
            </div>
          )}
          renderRow={(r) => (
            <tr
              className={cn(
                "border-b border-border/60 last:border-0",
                r.isCompany && "border-t-2 border-border bg-bg-muted/40 font-bold",
              )}
            >
              <td className={cn(TD, "break-words font-semibold")}>
                {r.href ? (
                  <Link className="hover:text-primary hover:underline" href={r.href}>
                    {r.label}
                  </Link>
                ) : (
                  r.label
                )}
              </td>
              <td className={TD}>
                {achCell(r.ach)}
                <span className="block text-phx-xs text-muted-foreground">{pct(r.exVacantAch)} excl. vac</span>
              </td>
              <td className={cn(TDR, "text-muted-foreground")}>
                {egp(r.sales)}
                <span className="block text-phx-xs">of {egp(r.target)}</span>
              </td>
              <td className={cn(TDR, "text-muted-foreground")}>
                {egp(r.marketing)}
                <span className="block text-phx-xs">{egp(r.expenses)} exp.</span>
              </td>
              <td className={TDR}>{num(r.earners)}</td>
              <td className={cn(TDR, "text-muted-foreground")}>
                {num(r.dms)}
                {r.dmsVacant > 0 && <span className="text-phx-xs"> +{r.dmsVacant} vac</span>}
              </td>
            </tr>
          )}
        />
      </Section>

      <Section title={`Company DSM league table (${dms.length} seats)`} note={`all lines together · all-products achievement → 2026 payout (90% = threshold) · ${company.meta.period}, period to date — not a settled semester payout`}>
        {/* Twelve columns merged to eight: the line chip and the band ride under the names they
            belong to, spend is one cell, and doubles ride under the visit rate. */}
        <ReviewTable
          breakpoint="lg"
          cols={<Cols fixed={[4, 20, 14, 9, 14, 15, 10, 14]} />}
          empty="No district carried a target in this view."
          getKey={(d) => `${d.lineId}:${d.dm}`}
          head={
            <>
              <th className={TH}>#</th>
              <th className={TH}>DSM</th>
              <th className={TH}>Achievement</th>
              <th className={THR}>Payout</th>
              <th className={THR}>Sales</th>
              <th className={THR}>Spend</th>
              <th className={THR}>Visits/mo</th>
              <th className={THR}>AM · PM · Pharmacies</th>
            </>
          }
          items={dms}
          renderCard={(d, i) => (
            <div className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className={CARD_TITLE}>
                    {i + 1}. {d.dm}
                    {d.vacant && <span className="ml-2 bg-bg-muted px-1.5 py-0.5 text-phx-2xs font-bold text-muted-foreground">VACANT</span>}
                  </h3>
                  <p className="mt-1"><LineChip line={d.line} /></p>
                </div>
                <div className="shrink-0 text-right">
                  {achCell(d.allProducts.ach)}
                  <p className="mt-1"><Band band={d.band} /></p>
                </div>
              </div>
              <CardFields
                items={[
                  { label: "Payout", value: d.payoutPct > 0 ? `${d.payoutPct.toFixed(0)}%` : "—" },
                  { label: "Sales", value: egp(d.allProducts.sales) },
                  { label: "Marketing", value: egp(d.marketingCost) },
                  { label: "Expenses", value: egp(d.outstationCost) },
                  { label: "Visits/mo", value: numOrNA(d.visitsAvgPerMonth, d.visitsAvailable) },
                  { label: "Doubles", value: numOrNA(d.doubleVisits, d.visitsAvailable) },
                  { label: "Customers", value: d.visitsAvailable ? customerSplitLabel(d) : "no data" },
                ]}
              />
            </div>
          )}
          renderRow={(d, i) => (
            <tr className={cn("border-b border-border/60 last:border-0", (d.allProducts.ach ?? 0) >= 90 && "bg-emerald-50/40")}>
              <td className={cn(TD, "text-muted-foreground")}>{i + 1}</td>
              <td className={cn(TD, "break-words font-semibold")}>
                {d.dm}
                {d.vacant && <span className="ml-2 bg-bg-muted px-1.5 py-0.5 text-phx-2xs font-bold text-muted-foreground">VACANT</span>}
                <span className="mt-1 block"><LineChip line={d.line} /></span>
              </td>
              <td className={TD}>
                {achCell(d.allProducts.ach)}
                <span className="mt-1 block"><Band band={d.band} /></span>
              </td>
              <td className={cn(TDR, "font-semibold")}>{d.payoutPct > 0 ? `${d.payoutPct.toFixed(0)}%` : "—"}</td>
              <td className={cn(TDR, "text-muted-foreground")}>{egp(d.allProducts.sales)}</td>
              <td className={cn(TDR, "text-muted-foreground")}>
                {egp(d.marketingCost)}
                <span className="block">{egp(d.outstationCost)} exp.</span>
              </td>
              <td className={TDR}>
                {numOrNA(d.visitsAvgPerMonth, d.visitsAvailable)}
                <span className="block text-muted-foreground">{numOrNA(d.doubleVisits, d.visitsAvailable)} doubles</span>
              </td>
              <td className={cn(TDR, "break-words")}>{d.visitsAvailable ? customerSplitLabel(d) : "no data"}</td>
            </tr>
          )}
        />
      </Section>

      <Section title={`Incentive earners — areas ≥ 90% company-wide (${earners.length})`} note={`threshold to unlock payout · vacant areas excluded · ${company.meta.period}, period to date — not a settled semester payout`}>
        <ReviewTable
          cols={<Cols fixed={[26, 24, 26, 24]} />}
          empty="No area reached the 90% threshold in this view."
          getKey={(a) => `${a.lineId}:${a.area}`}
          head={
            <>
              <th className={TH}>Area</th>
              <th className={TH}>DSM</th>
              <th className={TH}>Achievement</th>
              <th className={THR}>Payout</th>
            </>
          }
          items={earners}
          renderCard={(a) => (
            <div className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className={CARD_TITLE}>{a.area}</h3>
                  <p className={CARD_SUB}>{a.dm}</p>
                  <p className="mt-1"><LineChip line={a.line} /></p>
                </div>
                <div className="shrink-0 text-right">
                  {achCell(a.allProducts.ach)}
                  <p className="mt-1"><Band band={a.band} /></p>
                </div>
              </div>
              <CardFields items={[{ label: "Payout", value: `${a.payoutPct.toFixed(0)}%` }]} />
            </div>
          )}
          renderRow={(a) => (
            <tr className="border-b border-border/60 last:border-0">
              <td className={cn(TD, "break-words font-semibold")}>
                {a.area}
                <span className="mt-1 block"><LineChip line={a.line} /></span>
              </td>
              <td className={cn(TD, "break-words text-muted-foreground")}>{a.dm}</td>
              <td className={TD}>
                {achCell(a.allProducts.ach)}
                <span className="mt-1 block"><Band band={a.band} /></span>
              </td>
              <td className={cn(TDR, "font-semibold")}>{a.payoutPct.toFixed(0)}%</td>
            </tr>
          )}
        />
      </Section>
    </div>
  );
}

function CompanyFailsTab({ dms, areas, thresholds }: { dms: CoDmRow[]; areas: CoAreaRow[]; thresholds: Thresholds }) {
  // Identical rules to a line view, applied across all three lines at once. Vacant
  // areas are never failures — they are surfaced separately as uncovered territory.
  const failDms = dms.filter((d) => !d.vacant && (d.allProducts.ach ?? 999) < thresholds.dsmFailBelow);
  const failAreas = areas
    .filter((a) => !a.vacant && a.hasTarget && (a.allProducts.ach ?? 999) < thresholds.repFailBelow)
    .sort((a, b) => (a.allProducts.ach ?? 0) - (b.allProducts.ach ?? 0));
  const uncovered = areas.filter((a) => a.vacant).sort((a, b) => (a.allProducts.ach ?? 0) - (b.allProducts.ach ?? 0));
  const ungrade = areas.filter((a) => a.ungradeable && !a.vacant);
  return (
    <div className="space-y-4">
      <Section title={`DSMs below ${thresholds.dsmFailBelow}% company-wide (${failDms.length})`}>
        <ReviewTable
          cols={<Cols fixed={[28, 22, 25, 25]} />}
          empty="No DSM below threshold in this view."
          getKey={(d) => `${d.lineId}:${d.dm}`}
          head={
            <>
              <th className={TH}>DSM</th>
              <th className={TH}>Achievement</th>
              <th className={THR}>Sales</th>
              <th className={THR}>Target</th>
            </>
          }
          items={failDms}
          renderCard={(d) => (
            <div className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className={CARD_TITLE}>{d.dm}</h3>
                  <p className="mt-1"><LineChip line={d.line} /></p>
                </div>
                <span className="shrink-0">{achCell(d.allProducts.ach)}</span>
              </div>
              <CardFields
                items={[
                  { label: "Sales", value: egp(d.allProducts.sales) },
                  { label: "Target", value: egp(d.allProducts.target) },
                ]}
              />
            </div>
          )}
          renderRow={(d) => (
            <tr className="border-b border-border/60 last:border-0">
              <td className={cn(TD, "break-words font-semibold")}>
                {d.dm}
                <span className="mt-1 block"><LineChip line={d.line} /></span>
              </td>
              <td className={TD}>{achCell(d.allProducts.ach)}</td>
              <td className={cn(TDR, "text-muted-foreground")}>{egp(d.allProducts.sales)}</td>
              <td className={cn(TDR, "text-muted-foreground")}>{egp(d.allProducts.target)}</td>
            </tr>
          )}
        />
      </Section>

      {/* Per-product columns are deliberately omitted here: the three lines sell
          different catalogues, so there is no shared product set to column on. The
          per-line Performance Gaps tab still shows them. */}
      <Section title={`Rep areas below ${thresholds.repFailBelow}% company-wide (${failAreas.length})`} note="worst first · per-product detail lives in each line's own tab">
        <ReviewTable
          cols={<Cols fixed={[26, 22, 18, 22, 12]} />}
          empty="No rep area below threshold in this view."
          getKey={(a) => `${a.lineId}:${a.area}`}
          head={
            <>
              <th className={TH}>Area</th>
              <th className={TH}>DSM</th>
              <th className={TH}>Achievement</th>
              <th className={THR}>Sales</th>
              <th className={TH}>Flag</th>
            </>
          }
          items={failAreas}
          renderCard={(a) => (
            <div className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className={CARD_TITLE}>{a.area}</h3>
                  <p className={CARD_SUB}>{a.dm}</p>
                  <p className="mt-1"><LineChip line={a.line} /></p>
                </div>
                <div className="shrink-0 text-right">
                  {achCell(a.allProducts.ach)}
                  {a.hasReturns && <p className="mt-1 bg-red-100 px-1.5 py-0.5 text-phx-2xs font-bold text-red-600">RETURNS</p>}
                </div>
              </div>
              <CardFields items={[{ label: "Sales", value: egp(a.allProducts.sales) }]} />
            </div>
          )}
          renderRow={(a) => (
            <tr className="border-b border-border/60 last:border-0">
              <td className={cn(TD, "break-words font-semibold")}>
                {a.area}
                <span className="mt-1 block"><LineChip line={a.line} /></span>
              </td>
              <td className={cn(TD, "break-words text-xs text-muted-foreground")}>{a.dm}</td>
              <td className={TD}>{achCell(a.allProducts.ach)}</td>
              <td className={cn(TDR, "text-muted-foreground")}>{egp(a.allProducts.sales)}</td>
              <td className={TD}>
                {a.hasReturns ? <span className="bg-red-100 px-1.5 py-0.5 text-phx-2xs font-bold text-red-600">RETURNS</span> : ""}
              </td>
            </tr>
          )}
        />
      </Section>

      {uncovered.length > 0 && (
        <Section title={`Uncovered areas — vacant, no rep (${uncovered.length})`} note="excluded from failures · coverage gap, not a rep failure">
          <ReviewTable
            cols={<Cols fixed={[34, 20, 26, 20]} />}
            empty="Every area in this view has a rep."
            getKey={(a) => `${a.lineId}:${a.area}`}
            head={
              <>
                <th className={TH}>Area</th>
                <th className={TH}>Line</th>
                <th className={TH}>DSM</th>
                <th className={THR}>Achievement</th>
              </>
            }
            items={uncovered}
            renderCard={(a) => (
              <div className="flex items-start justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0">
                  <h3 className={CARD_TITLE}>{a.area}</h3>
                  <p className={CARD_SUB}>{a.dm}</p>
                  <p className="mt-1"><LineChip line={a.line} /></p>
                </div>
                <span className="shrink-0">{achCell(a.allProducts.ach)}</span>
              </div>
            )}
            renderRow={(a) => (
              <tr className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "break-words font-semibold")}>{a.area}</td>
                <td className={TD}>
                  <LineChip line={a.line} />
                </td>
                <td className={cn(TD, "break-words text-muted-foreground")}>{a.dm}</td>
                <td className={TDR}>{achCell(a.allProducts.ach)}</td>
              </tr>
            )}
          />
        </Section>
      )}

      {ungrade.length > 0 && (
        <Section title={`Ungradeable — sales but no target (${ungrade.length})`} note="target-setting gap, not a failure">
          <ReviewTable
            cols={<Cols fixed={[32, 18, 24, 26]} />}
            empty="Every area with sales in this view carries a target."
            getKey={(a) => `${a.lineId}:${a.area}`}
            head={
              <>
                <th className={TH}>Area</th>
                <th className={TH}>Line</th>
                <th className={TH}>DSM</th>
                <th className={THR}>Sales (no target)</th>
              </>
            }
            items={ungrade}
            renderCard={(a) => (
              <div className="flex items-start justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0">
                  <h3 className={CARD_TITLE}>{a.area}</h3>
                  <p className={CARD_SUB}>{a.dm}</p>
                  <p className="mt-1"><LineChip line={a.line} /></p>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums">{egp(a.allProducts.sales)}</span>
              </div>
            )}
            renderRow={(a) => (
              <tr className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "break-words font-semibold")}>{a.area}</td>
                <td className={TD}>
                  <LineChip line={a.line} />
                </td>
                <td className={cn(TD, "break-words text-muted-foreground")}>{a.dm}</td>
                <td className={TDR}>{egp(a.allProducts.sales)}</td>
              </tr>
            )}
          />
        </Section>
      )}
    </div>
  );
}

function CompanyDeepTab({
  company, dms, areas, months, productTables, customersOk, people,
}: {
  company: ReviewCompany;
  dms: CoDmRow[];
  areas: CoAreaRow[];
  months: string[];
  productTables: { id: ReviewLine; label: string; products: ProductRow[] }[];
  customersOk: boolean;
  people: ReviewCompany["people"];
}) {
  const T = company.total;
  return (
    <div className="space-y-4">
      <Section title="Company monthly trend" note={company.meta.doctorNote}>
        <MonthGridTable
          empty="No month in this window carries a company figure."
          firstHead="Metric"
          months={months}
          rows={[
            { key: "ach", kind: "ach" as const, label: "Sales achievement", values: months.map((m) => T.byMonth[m]?.ach ?? null) },
            { key: "customers", kind: "num" as const, label: "Customers reached", values: months.map((m) => T.customersByMonth[m] ?? 0) },
          ]}
        />
      </Section>

      {/* Per-DSM deep dives, all lines in one ranked list. Each DM's product/family mix
          comes from that DM's own line catalogue. */}
      {dms.map((d) => {
        const useFamily = d.families.length > 1 && d.families.length < d.keyProducts.length;
        const mixRows: { label: string; ach: number | null }[] = useFamily
          ? d.families.map((f) => ({ label: f.trim(), ach: d.familyAch?.[f] ?? null }))
          : d.keyProducts.map((p) => ({ label: p, ach: d.productAch?.[p] ?? null }));
        return (
          <div key={`${d.lineId}:${d.dm}`} className="rounded-xl border border-border bg-card shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-sm font-bold">{d.dm}</h2>
                <LineChip line={d.line} />
                <span className={cn("text-lg font-bold", achColor(d.allProducts.ach))}>{pct(d.allProducts.ach)}</span>
                <Band band={d.band} />
                {d.vacant && <span className="rounded bg-bg-muted px-1.5 py-0.5 text-phx-2xs font-bold text-muted-foreground">VACANT</span>}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>Payout <b className="text-foreground">{d.payoutPct.toFixed(0)}%</b></span>
                <span>Mktg <b className="text-foreground">{egp(d.marketingCost)}</b> ({d.marketingMonths}mo)</span>
                <span>Exp <b className="text-foreground">{egp(d.outstationCost)}</b></span>
                <span>Customers <b className="text-foreground">{d.visitsAvailable ? customerSplitLabel(d) : "no data"}</b></span>
                <span>Doubles <b className="text-foreground">{numOrNA(d.doubleVisits, d.visitsAvailable)}</b></span>
              </div>
            </div>
            {/* `min-w-0` on both halves — see the per-line Deep Analysis tab. */}
            <div className="grid gap-3 p-3 lg:grid-cols-[1.6fr_1fr]">
              <div className="min-w-0">
                <MonthGridTable
                  empty="No month in this window carries a figure for this district."
                  firstHead="Monthly"
                  months={months}
                  rows={[
                    { key: "ach", kind: "ach" as const, label: "Achievement", values: months.map((m) => d.achByMonth?.[m] ?? null) },
                    ...(d.visitsAvailable
                      ? [
                          { key: "visits", kind: "num" as const, label: "Visits", values: months.map((m) => d.visitsByMonth?.[m] ?? 0) },
                          { key: "customers", kind: "num" as const, label: "Customers", values: months.map((m) => d.customersByMonth?.[m] ?? 0) },
                        ]
                      : []),
                  ]}
                />
              </div>
              <div className="min-w-0">
                <ReviewTable
                  cols={<Cols fixed={[62, 38]} />}
                  empty="No mix to show for this district."
                  getKey={(r) => r.label}
                  head={
                    <>
                      <th className={TH}>{useFamily ? "Family mix" : "Product mix"}</th>
                      <th className={THR}>Achievement</th>
                    </>
                  }
                  items={mixRows}
                  renderCard={(r) => (
                    <div className="flex items-start justify-between gap-3 px-4 py-3">
                      <span className="min-w-0 break-words text-sm font-medium">{r.label}</span>
                      <span className="shrink-0">{achCell(r.ach)}</span>
                    </div>
                  )}
                  renderRow={(r) => (
                    <tr className="border-b border-border/50 last:border-0">
                      <td className={cn(TD, "break-words font-medium")}>{r.label}</td>
                      <td className={TDR}>{achCell(r.ach)}</td>
                    </tr>
                  )}
                />
              </div>
            </div>
          </div>
        );
      })}

      {/* Kept as three separate tables: the lines share no products, so a single merged
          product table would imply a common catalogue that does not exist. */}
      {productTables.map((pt) => (
        <Section key={pt.id} title={`${pt.label} — achievement per product per month`} note="★ include products">
          <MonthGridTable
            empty="No product on this line carried sales or a target in this window."
            firstHead="Product"
            months={months}
            rows={pt.products.map((p) => ({
              key: p.product,
              kind: "ach" as const,
              label: (
                <>
                  {p.include && <span className="mr-1 text-amber-500">★</span>}
                  {p.product}
                </>
              ),
              total: p.total.ach,
              values: months.map((m) => p.byMonth[m]?.ach ?? null),
            }))}
            totalHead="Total"
          />
        </Section>
      ))}

      {/* Doctors per area, month by month, across every line. Areas are unique per line, so the
          line column is shown here and not in the per-line view. */}
      <CustomersByAreaTable
        areas={areas.map((a) => ({
          area: a.area,
          line: a.line,
          dm: a.dm,
          vacant: a.vacant,
          customersTotal: a.customersTotal,
          customersByMonth: a.customersByMonth,
          customersAm: a.customersAm,
          customersPm: a.customersPm,
          customersPharmacy: a.customersPharmacy,
          visitSplit: a.visitSplit,
        }))}
        months={months}
        showLine
        visitsAvailable={customersOk}
      />

      <RoleActivityTable roles={company.roles} scopeNote="all three lines" />
      <PeopleActivityTable people={people} scopeNote="all three lines" />
    </div>
  );
}
