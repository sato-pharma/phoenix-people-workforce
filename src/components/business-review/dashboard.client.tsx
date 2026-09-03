"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Download, FileSpreadsheet } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ReviewLine, ReviewView } from "@/lib/business-review/service";
import { REVIEW_VIEWS } from "@/lib/business-review/review-views";
import { hasFigures, type ReviewCoverage } from "@/lib/business-review/coverage";
import { periodColumnLabel } from "@/lib/business-review/period-format";
import type { ReviewWindow } from "@/lib/business-review/period";
import type { AreaSummary, DmSummary, ProductRow, ReviewCompany, ReviewDataset } from "@/lib/business-review/types";
import {
  CoverageBanner,
  CoverageTab,
  HardEmptyWindow,
  type CoverageProvenance,
} from "./coverage.client";
import { ReviewPeriodFilter } from "./review-filter.client";
import { CustomersByAreaTable, PeopleActivityTable, RoleActivityTable } from "./rollups.client";

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
  new Intl.NumberFormat("en-US", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(Number.isFinite(n) ? n : 0);
const pct = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);
const num = (n: number | null | undefined) => (n != null && Number.isFinite(n) ? n.toLocaleString("en-US") : "0");
/** Renders "no data" instead of a misleading 0 when the source holds no rows for this
 *  window. A zero here would read as "nobody visited anybody", which is an accusation. */
const numOrNA = (n: number | null | undefined, available: boolean) => (available ? num(n) : "no data");
const egpOrNA = (n: number, available: boolean) => (available ? egp(n) : "no data");

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
  children,
}: {
  title: string;
  subtitle: string;
  current: ReviewView;
  window: ReviewWindow;
  available: string[];
  children?: React.ReactNode;
}) {
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
        hidden={{ line: current }}
      />
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
  window: reviewWindow, coverage, provenance, available,
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
        title={`All Company — ${reviewWindow.label}`}
        subtitle={`${company.meta.lines.length} lines consolidated · ≥90% = earner · viewing as ${viewerRole}`}
      >
        <label className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2">
          <Switch checked={excludeVacant} onChange={setExcludeVacant} label="Exclude vacant territories" />
          <span className="text-sm font-medium">Exclude vacant</span>
        </label>
      </ReviewHeader>

      <RestatementBanner notice={restatementNotice} />
      <CoverageBanner coverage={coverage} />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi label="Company achievement" value={coverage.ungradeable ? "not gradeable" : pct(T.allProducts.ach)} sub={coverage.ungradeable ? "no targets loaded for this window" : "all 3 lines · all areas"} accent={coverage.ungradeable ? undefined : achColor(T.allProducts.ach)} />
        <Kpi label="Sales (total)" value={egp(T.allProducts.sales)} sub={coverage.ungradeable ? "value only" : `of ${egp(T.allProducts.target)}`} />
        <Kpi label="Doctors reached" value={numOrNA(T.customersTotal, customersOk)} sub={customersOk ? "unique across all lines" : "no CRM rows in this window"} />
        <Kpi label="Marketing + exp." value={marketingOk || outstationOk ? egp(T.marketingCost + T.outstationCost) : "no data"} sub={`${egpOrNA(T.marketingCost, marketingOk)} + ${egpOrNA(T.outstationCost, outstationOk)}`} />
        <Kpi label="Visits" value={numOrNA(T.visits, visitsOk)} sub={visitsOk ? `${num(T.reps)} reps · ${num(T.doubleVisits)} doubles` : "no CRM rows in this window"} />
      </section>

      <nav className="flex gap-1 rounded-lg border border-border bg-card p-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} type="button"
            className={cn("flex-1 rounded-md px-3 py-2 text-sm font-semibold transition-colors", tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-bg-muted")}>
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
        />
      )}
      {tab === "coverage" && <CoverageTab coverage={coverage} provenance={provenance} />}
    </div>
  );
}

function LineDashboard({
  ds, dms, areas, viewerRole, view: currentLine, restatementNotice,
  window: reviewWindow, coverage, provenance, available, company,
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

  return (
    <div className="space-y-5">
      <ReviewHeader
        current={currentLine}
        window={reviewWindow}
        available={available}
        title={`${ds.meta.line} Line — ${reviewWindow.label}`}
        subtitle={`all products · ≥90% = earner · viewing as ${viewerRole}`}
      >
        <label className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2">
          <Switch checked={excludeVacant} onChange={setExcludeVacant} label="Exclude vacant territories" />
          <span className="text-sm font-medium">Exclude vacant</span>
        </label>
      </ReviewHeader>

      <RestatementBanner notice={restatementNotice} />
      <CoverageBanner coverage={coverage} />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Line achievement" value={ds.line.allProducts.target > 0 ? pct(line.ach) : "not gradeable"} sub={ds.line.allProducts.target > 0 ? "all areas · all products" : "no targets loaded for this window"} accent={ds.line.allProducts.target > 0 ? achColor(line.ach) : undefined} />
        <Kpi label="Sales (total)" value={egp(line.sales)} sub={line.target > 0 ? `of ${egp(line.target)}` : "value only"} />
        <Kpi label="Doctors reached" value={numOrNA(ds.line.customersTotal, customersOk)} sub={customersOk ? `${num(ds.line.customersByMonth[M[0]] ?? 0)} → ${num(ds.line.customersByMonth[M[M.length - 1]] ?? 0)} /mo` : "no CRM rows in this window"} />
        <Kpi label="Marketing cost" value={egpOrNA(ds.line.marketingCost, marketingOk)} sub={marketingOk ? "committed only" : "no requests in this window"} />
        <Kpi label="Outstation exp." value={egpOrNA(ds.line.outstationCost, outstationOk)} sub={outstationOk ? `${egp(ds.line.outstationApproved)} HR-approved` : "no claims in this window"} />
        <Kpi label="Visits / rep / mo" value={numOrNA(ds.line.visitsAvgPerRepPerMonth, visitsOk)} sub={visitsOk ? `${num(ds.line.visits)} total · ${num(ds.line.visitingReps)} reps` : "no CRM rows in this window"} />
      </section>

      <nav className="flex gap-1 rounded-lg border border-border bg-card p-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} type="button"
            className={cn("flex-1 rounded-md px-3 py-2 text-sm font-semibold transition-colors", tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-bg-muted")}>
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
          roles={company.roles}
          people={company.people}
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
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-bold">{title}</h2>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      <div className="overflow-x-auto p-1">{children}</div>
    </div>
  );
}
const TH = "px-3 py-2 text-left text-phx-xs font-bold uppercase tracking-wide text-muted-foreground";
const THR = "px-3 py-2 text-right text-phx-xs font-bold uppercase tracking-wide text-muted-foreground";
const TD = "px-3 py-2 text-sm";
const TDR = "px-3 py-2 text-sm text-right tabular-nums";

function AchieversTab({ dms, areas, visitsAvailable }: { dms: DmRow[]; areas: AreaRow[]; visitsAvailable: boolean }) {
  // Vacant areas never count as earners — no rep held the territory, so residual
  // pharmacy-stock sales aren't an earned achievement. Mirrors how FailsTab excludes
  // vacant areas from failures and lists them separately as uncovered territory.
  const earners = areas.filter((a) => !a.vacant && a.hasTarget && (a.allProducts.ach ?? 0) >= 90).sort((a, b) => (b.allProducts.ach ?? 0) - (a.allProducts.ach ?? 0));
  return (
    <div className="space-y-4">
      <Section title="DSM league table" note="all-products achievement → 2026 payout (90% = threshold)">
        <table className="w-full min-w-[860px] border-collapse">
          <thead><tr className="border-b border-border">
            <th className={TH}>#</th><th className={TH}>DSM</th><th className={TH}>Achievement</th><th className={TH}>Band</th><th className={THR}>Payout</th>
            <th className={THR}>Marketing</th><th className={THR}>Expenses</th><th className={THR}>Visits/mo</th><th className={THR}>Doctors</th><th className={THR}>Doubles</th>
          </tr></thead>
          <tbody>
            {dms.map((d, i) => (
              <tr key={d.dm} className={cn("border-b border-border/60 last:border-0", (d.allProducts.ach ?? 0) >= 90 && "bg-emerald-50/40")}>
                <td className={cn(TD, "text-muted-foreground")}>{i + 1}</td>
                <td className={cn(TD, "font-semibold")}>{d.dm}{d.vacant && <span className="ml-2 rounded bg-bg-muted px-1.5 py-0.5 text-phx-2xs font-bold text-muted-foreground">VACANT</span>}</td>
                <td className={TD}>{achCell(d.allProducts.ach)}</td>
                <td className={TD}><Band band={d.band} /></td>
                <td className={cn(TDR, "font-semibold")}>{d.payoutPct > 0 ? `${d.payoutPct.toFixed(0)}%` : "—"}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{egp(d.marketingCost)}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{egp(d.outstationCost)}</td>
                <td className={TDR}>{numOrNA(d.visitsAvgPerMonth, visitsAvailable)}</td>
                <td className={TDR}>{numOrNA(d.customersTotal, visitsAvailable)}</td>
                <td className={TDR}>{numOrNA(d.doubleVisits, visitsAvailable)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={`Incentive earners — areas ≥ 90% (${earners.length})`} note="threshold to unlock payout">
        <table className="w-full min-w-[620px] border-collapse">
          <thead><tr className="border-b border-border"><th className={TH}>Area</th><th className={TH}>DSM</th><th className={TH}>Achievement</th><th className={TH}>Band</th><th className={THR}>Payout</th></tr></thead>
          <tbody>
            {earners.map((a) => (
              <tr key={a.area} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>{a.area}</td>
                <td className={cn(TD, "text-muted-foreground")}>{a.dm}</td>
                <td className={TD}>{achCell(a.allProducts.ach)}</td>
                <td className={TD}><Band band={a.band} /></td>
                <td className={cn(TDR, "font-semibold")}>{a.payoutPct.toFixed(0)}%</td>
              </tr>
            ))}
            {earners.length === 0 && <tr><td className={cn(TD, "text-muted-foreground")} colSpan={5}>No area reached the 90% threshold in this view.</td></tr>}
          </tbody>
        </table>
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
        <table className="w-full min-w-[520px] border-collapse">
          <thead><tr className="border-b border-border"><th className={TH}>DSM</th><th className={TH}>Achievement</th><th className={THR}>Sales</th><th className={THR}>Target</th></tr></thead>
          <tbody>
            {failDms.map((d) => (
              <tr key={d.dm} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>{d.dm}</td><td className={TD}>{achCell(d.allProducts.ach)}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{egp(d.allProducts.sales)}</td><td className={cn(TDR, "text-muted-foreground")}>{egp(d.allProducts.target)}</td>
              </tr>
            ))}
            {failDms.length === 0 && <tr><td className={cn(TD, "text-muted-foreground")} colSpan={4}>No DSM below threshold in this view.</td></tr>}
          </tbody>
        </table>
      </Section>

      <Section title={`Rep areas below ${thresholds.repFailBelow}% (${failAreas.length})`} note="per-product achievement + trend">
        <table className="w-full min-w-[880px] border-collapse">
          <thead><tr className="border-b border-border">
            <th className={TH}>Area</th><th className={TH}>DSM</th><th className={TH}>Total</th>
            {prods.map((p) => <th key={p} className={THR}>{p.replace("Lacto Advanced", "Lacto")}</th>)}<th className={TH}>Flag</th>
          </tr></thead>
          <tbody>
            {failAreas.map((a) => (
              <tr key={a.area} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>{a.area}</td>
                <td className={cn(TD, "text-xs text-muted-foreground")}>{a.dm}</td>
                <td className={TD}>{achCell(a.allProducts.ach)}</td>
                {prods.map((p) => <td key={p} className={TDR}>{achCell(a.products?.[p]?.ach ?? null)}</td>)}
                <td className={TD}>{a.hasReturns ? <span className="rounded bg-red-100 px-1.5 py-0.5 text-phx-2xs font-bold text-red-600">RETURNS</span> : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {uncovered.length > 0 && (
        <Section title={`Uncovered areas — vacant, no rep (${uncovered.length})`} note="excluded from failures · coverage gap, not a rep failure">
          <table className="w-full min-w-[520px] border-collapse">
            <thead><tr className="border-b border-border"><th className={TH}>Area</th><th className={TH}>DSM</th><th className={THR}>Achievement</th></tr></thead>
            <tbody>{uncovered.map((a) => (
              <tr key={a.area} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>{a.area}</td><td className={cn(TD, "text-muted-foreground")}>{a.dm}</td><td className={TDR}>{achCell(a.allProducts.ach)}</td>
              </tr>))}
            </tbody>
          </table>
        </Section>
      )}

      {ungrade.length > 0 && (
        <Section title={`Ungradeable — sales but no target (${ungrade.length})`} note="target-setting gap, not a failure">
          <table className="w-full min-w-[420px] border-collapse">
            <thead><tr className="border-b border-border"><th className={TH}>Area</th><th className={TH}>DSM</th><th className={THR}>Sales (no target)</th></tr></thead>
            <tbody>{ungrade.map((a) => (
              <tr key={a.area} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>{a.area}</td><td className={cn(TD, "text-muted-foreground")}>{a.dm}</td><td className={TDR}>{egp(a.allProducts.sales)}</td>
              </tr>))}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}

function MiniMonth({ label, months, values, kind }: { label: string; months: string[]; values: (number | null)[]; kind: "ach" | "num" }) {
  return (
    <tr className="border-b border-border/50 last:border-0">
      <td className={cn(TD, "font-medium text-muted-foreground")}>{label}</td>
      {values.map((v, i) => <td key={months[i]} className={TDR}>{kind === "ach" ? achCell(v) : num(v)}</td>)}
    </tr>
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
      f.covered[m] = (f.covered[m] ?? 0) + (p.byMonth[m]?.covered ?? 0);
      f.target[m] = (f.target[m] ?? 0) + (p.byMonth[m]?.target ?? 0);
    }
    f.totalCovered += p.total.covered;
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
        <div key={d.dm} className="rounded-xl border border-border bg-card shadow-sm">
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
              <span>Doctors <b className="text-foreground">{numOrNA(d.customersTotal, ds.visits.available)}</b></span>
              <span>Doubles <b className="text-foreground">{numOrNA(d.doubleVisits, ds.visits.available)}</b></span>
            </div>
          </div>
          <div className="grid gap-3 p-3 lg:grid-cols-[1.6fr_1fr]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[440px] border-collapse">
                <thead><tr className="border-b border-border"><th className={TH}>Monthly</th>{months.map((m) => <th key={m} className={THR}>{periodColumnLabel(m, months)}</th>)}</tr></thead>
                <tbody>
                  <MiniMonth label="Achievement" months={months} values={months.map((m) => d.achByMonth?.[m] ?? null)} kind="ach" />
                  {ds.visits.available && <MiniMonth label="Visits" months={months} values={months.map((m) => d.visitsByMonth?.[m] ?? 0)} kind="num" />}
                  {ds.visits.available && <MiniMonth label="Doctors" months={months} values={months.map((m) => d.customersByMonth?.[m] ?? 0)} kind="num" />}
                </tbody>
              </table>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[240px] border-collapse">
                <thead><tr className="border-b border-border"><th className={TH}>{mixByFamily ? "Family mix" : "Product mix"}</th><th className={THR}>Achievement</th></tr></thead>
                <tbody>
                  {mixByFamily
                    ? families.map((f) => (
                        <tr key={f.family} className="border-b border-border/50 last:border-0">
                          <td className={cn(TD, "font-medium")}>{f.family.trim()} <span className="text-xs text-muted-foreground">({f.skuCount})</span></td>
                          <td className={TDR}>{achCell(d.familyAch?.[f.family] ?? null)}</td>
                        </tr>
                      ))
                    : keyProducts.map((p) => (
                        <tr key={p} className="border-b border-border/50 last:border-0"><td className={cn(TD, "font-medium")}>{p}</td><td className={TDR}>{achCell(d.productAch?.[p] ?? null)}</td></tr>
                      ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ))}

      {mixByFamily && (
        <Section title="Achievement per product family per month" note="rolled up across each family's include-eligible SKUs">
          <table className="w-full min-w-[720px] border-collapse">
            <thead><tr className="border-b border-border"><th className={TH}>Family</th>{months.map((m) => <th key={m} className={THR}>{periodColumnLabel(m, months)}</th>)}<th className={THR}>Total</th></tr></thead>
            <tbody>
              {families.map((f) => (
                <tr key={f.family} className="border-b border-border/60 last:border-0">
                  <td className={cn(TD, "font-medium")}>{f.family.trim()} <span className="text-xs text-muted-foreground">({f.skuCount} SKU{f.skuCount === 1 ? "" : "s"})</span></td>
                  {months.map((m) => <td key={m} className={TDR}>{achCell(f.byMonth[m] ?? null)}</td>)}
                  <td className={cn(TDR, "font-bold")}>{achCell(f.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section title="Achievement per product per month" note="★ include products">
        <table className="w-full min-w-[720px] border-collapse">
          <thead><tr className="border-b border-border"><th className={TH}>Product</th>{months.map((m) => <th key={m} className={THR}>{periodColumnLabel(m, months)}</th>)}<th className={THR}>Total</th></tr></thead>
          <tbody>
            {ds.products.filter((p) => p.total.target > 0 || p.total.sales > 0).map((p) => (
              <tr key={p.product} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-medium")}>{p.include && <span className="mr-1 text-amber-500">★</span>}{p.product}</td>
                {months.map((m) => <td key={m} className={TDR}>{achCell(p.byMonth[m]?.ach ?? null)}</td>)}
                <td className={cn(TDR, "font-bold")}>{achCell(p.total.ach)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Line trend" note={ds.visits.available ? `${num(ds.visits.totalDeduped)} visits · ${num(ds.line.customersTotal)} doctors` : "no CRM visit rows in this window"}>
        <table className="w-full min-w-[620px] border-collapse">
          <thead><tr className="border-b border-border"><th className={TH}>Metric</th>{months.map((m) => <th key={m} className={THR}>{periodColumnLabel(m, months)}</th>)}</tr></thead>
          <tbody>
            <MiniMonth label="Sales achievement" months={months} values={months.map((m) => ds.line.byMonth[m]?.allProducts.ach ?? null)} kind="ach" />
            <MiniMonth label="Sales value" months={months} values={months.map((m) => ds.line.byMonth[m]?.allProducts.sales ?? 0)} kind="num" />
            {ds.visits.available && <MiniMonth label="Visits" months={months} values={months.map((m) => ds.visits.byMonth[m] ?? 0)} kind="num" />}
            {ds.visits.available && <MiniMonth label="Doctors reached" months={months} values={months.map((m) => ds.line.customersByMonth[m] ?? 0)} kind="num" />}
          </tbody>
        </table>
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
        }))}
        months={months}
        visitsAvailable={customersOk}
      />

      <RoleActivityTable roles={roles} />
      <PeopleActivityTable people={people} />
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
  return (
    <div className="space-y-4">
      <Section title="Line comparison" note="ranked by achievement · sum(sales)/sum(target), never an average of percentages">
        <table className="w-full min-w-[980px] border-collapse">
          <thead><tr className="border-b border-border">
            <th className={TH}>Line</th><th className={TH}>Achievement</th><th className={THR}>Sales</th><th className={THR}>Target</th>
            <th className={THR}>Excl. vacant</th><th className={THR}>Marketing</th><th className={THR}>Expenses</th>
            <th className={THR}>Earners</th><th className={THR}>DM seats</th>
          </tr></thead>
          <tbody>
            {company.lines.map((l) => (
              <tr key={l.id} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>
                  <Link href={`/business-review?line=${l.id}`} className="hover:text-primary hover:underline">{l.label}</Link>
                </td>
                <td className={TD}>{achCell(l.allProducts.ach)}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{egp(l.allProducts.sales)}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{egp(l.allProducts.target)}</td>
                <td className={TDR}>{achCell(l.exVacant.ach)}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{egp(l.marketingCost)}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{egp(l.outstationCost)}</td>
                <td className={TDR}>{num(l.earners)}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{num(l.dms)}{l.dmsVacant > 0 && <span className="text-phx-xs"> +{l.dmsVacant} vac</span>}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-border bg-bg-muted/40 font-bold">
              <td className={TD}>Company</td>
              <td className={TD}>{achCell(T.allProducts.ach)}</td>
              <td className={TDR}>{egp(T.allProducts.sales)}</td>
              <td className={TDR}>{egp(T.allProducts.target)}</td>
              <td className={TDR}>{achCell(T.exVacant.ach)}</td>
              <td className={TDR}>{egp(T.marketingCost)}</td>
              <td className={TDR}>{egp(T.outstationCost)}</td>
              <td className={TDR}>{num(company.lines.reduce((s, l) => s + l.earners, 0))}</td>
              <td className={TDR}>{num(company.lines.reduce((s, l) => s + l.dms, 0))}<span className="text-phx-xs"> +{company.lines.reduce((s, l) => s + l.dmsVacant, 0)} vac</span></td>
            </tr>
          </tbody>
        </table>
      </Section>

      <Section title={`Company DSM league table (${dms.length} seats)`} note="all lines together · all-products achievement → 2026 payout (90% = threshold)">
        <table className="w-full min-w-[960px] border-collapse">
          <thead><tr className="border-b border-border">
            <th className={TH}>#</th><th className={TH}>DSM</th><th className={TH}>Line</th><th className={TH}>Achievement</th>
            <th className={TH}>Band</th><th className={THR}>Payout</th><th className={THR}>Sales</th>
            <th className={THR}>Marketing</th><th className={THR}>Expenses</th>
            <th className={THR}>Visits/mo</th><th className={THR}>Doctors</th><th className={THR}>Doubles</th>
          </tr></thead>
          <tbody>
            {dms.map((d, i) => (
              <tr key={`${d.lineId}:${d.dm}`} className={cn("border-b border-border/60 last:border-0", (d.allProducts.ach ?? 0) >= 90 && "bg-emerald-50/40")}>
                <td className={cn(TD, "text-muted-foreground")}>{i + 1}</td>
                <td className={cn(TD, "font-semibold")}>{d.dm}{d.vacant && <span className="ml-2 rounded bg-bg-muted px-1.5 py-0.5 text-phx-2xs font-bold text-muted-foreground">VACANT</span>}</td>
                <td className={TD}><LineChip line={d.line} /></td>
                <td className={TD}>{achCell(d.allProducts.ach)}</td>
                <td className={TD}><Band band={d.band} /></td>
                <td className={cn(TDR, "font-semibold")}>{d.payoutPct > 0 ? `${d.payoutPct.toFixed(0)}%` : "—"}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{egp(d.allProducts.sales)}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{egp(d.marketingCost)}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{egp(d.outstationCost)}</td>
                <td className={TDR}>{numOrNA(d.visitsAvgPerMonth, d.visitsAvailable)}</td>
                <td className={TDR}>{numOrNA(d.customersTotal, d.visitsAvailable)}</td>
                <td className={TDR}>{numOrNA(d.doubleVisits, d.visitsAvailable)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={`Incentive earners — areas ≥ 90% company-wide (${earners.length})`} note="threshold to unlock payout · vacant areas excluded">
        <table className="w-full min-w-[720px] border-collapse">
          <thead><tr className="border-b border-border">
            <th className={TH}>Area</th><th className={TH}>Line</th><th className={TH}>DSM</th><th className={TH}>Achievement</th><th className={TH}>Band</th><th className={THR}>Payout</th>
          </tr></thead>
          <tbody>
            {earners.map((a) => (
              <tr key={`${a.lineId}:${a.area}`} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>{a.area}</td>
                <td className={TD}><LineChip line={a.line} /></td>
                <td className={cn(TD, "text-muted-foreground")}>{a.dm}</td>
                <td className={TD}>{achCell(a.allProducts.ach)}</td>
                <td className={TD}><Band band={a.band} /></td>
                <td className={cn(TDR, "font-semibold")}>{a.payoutPct.toFixed(0)}%</td>
              </tr>
            ))}
            {earners.length === 0 && <tr><td className={cn(TD, "text-muted-foreground")} colSpan={6}>No area reached the 90% threshold in this view.</td></tr>}
          </tbody>
        </table>
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
        <table className="w-full min-w-[640px] border-collapse">
          <thead><tr className="border-b border-border">
            <th className={TH}>DSM</th><th className={TH}>Line</th><th className={TH}>Achievement</th><th className={THR}>Sales</th><th className={THR}>Target</th>
          </tr></thead>
          <tbody>
            {failDms.map((d) => (
              <tr key={`${d.lineId}:${d.dm}`} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>{d.dm}</td>
                <td className={TD}><LineChip line={d.line} /></td>
                <td className={TD}>{achCell(d.allProducts.ach)}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{egp(d.allProducts.sales)}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{egp(d.allProducts.target)}</td>
              </tr>
            ))}
            {failDms.length === 0 && <tr><td className={cn(TD, "text-muted-foreground")} colSpan={5}>No DSM below threshold in this view.</td></tr>}
          </tbody>
        </table>
      </Section>

      {/* Per-product columns are deliberately omitted here: the three lines sell
          different catalogues, so there is no shared product set to column on. The
          per-line Performance Gaps tab still shows them. */}
      <Section title={`Rep areas below ${thresholds.repFailBelow}% company-wide (${failAreas.length})`} note="worst first · per-product detail lives in each line's own tab">
        <table className="w-full min-w-[680px] border-collapse">
          <thead><tr className="border-b border-border">
            <th className={TH}>Area</th><th className={TH}>Line</th><th className={TH}>DSM</th><th className={TH}>Achievement</th><th className={THR}>Sales</th><th className={TH}>Flag</th>
          </tr></thead>
          <tbody>
            {failAreas.map((a) => (
              <tr key={`${a.lineId}:${a.area}`} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>{a.area}</td>
                <td className={TD}><LineChip line={a.line} /></td>
                <td className={cn(TD, "text-xs text-muted-foreground")}>{a.dm}</td>
                <td className={TD}>{achCell(a.allProducts.ach)}</td>
                <td className={cn(TDR, "text-muted-foreground")}>{egp(a.allProducts.sales)}</td>
                <td className={TD}>{a.hasReturns ? <span className="rounded bg-red-100 px-1.5 py-0.5 text-phx-2xs font-bold text-red-600">RETURNS</span> : ""}</td>
              </tr>
            ))}
            {failAreas.length === 0 && <tr><td className={cn(TD, "text-muted-foreground")} colSpan={6}>No rep area below threshold in this view.</td></tr>}
          </tbody>
        </table>
      </Section>

      {uncovered.length > 0 && (
        <Section title={`Uncovered areas — vacant, no rep (${uncovered.length})`} note="excluded from failures · coverage gap, not a rep failure">
          <table className="w-full min-w-[620px] border-collapse">
            <thead><tr className="border-b border-border">
              <th className={TH}>Area</th><th className={TH}>Line</th><th className={TH}>DSM</th><th className={THR}>Achievement</th>
            </tr></thead>
            <tbody>{uncovered.map((a) => (
              <tr key={`${a.lineId}:${a.area}`} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>{a.area}</td>
                <td className={TD}><LineChip line={a.line} /></td>
                <td className={cn(TD, "text-muted-foreground")}>{a.dm}</td>
                <td className={TDR}>{achCell(a.allProducts.ach)}</td>
              </tr>))}
            </tbody>
          </table>
        </Section>
      )}

      {ungrade.length > 0 && (
        <Section title={`Ungradeable — sales but no target (${ungrade.length})`} note="target-setting gap, not a failure">
          <table className="w-full min-w-[540px] border-collapse">
            <thead><tr className="border-b border-border">
              <th className={TH}>Area</th><th className={TH}>Line</th><th className={TH}>DSM</th><th className={THR}>Sales (no target)</th>
            </tr></thead>
            <tbody>{ungrade.map((a) => (
              <tr key={`${a.lineId}:${a.area}`} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>{a.area}</td>
                <td className={TD}><LineChip line={a.line} /></td>
                <td className={cn(TD, "text-muted-foreground")}>{a.dm}</td>
                <td className={TDR}>{egp(a.allProducts.sales)}</td>
              </tr>))}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}

function CompanyDeepTab({
  company, dms, areas, months, productTables, customersOk,
}: {
  company: ReviewCompany;
  dms: CoDmRow[];
  areas: CoAreaRow[];
  months: string[];
  productTables: { id: ReviewLine; label: string; products: ProductRow[] }[];
  customersOk: boolean;
}) {
  const T = company.total;
  return (
    <div className="space-y-4">
      <Section title="Company monthly trend" note={company.meta.doctorNote}>
        <table className="w-full min-w-[620px] border-collapse">
          <thead><tr className="border-b border-border"><th className={TH}>Metric</th>{months.map((m) => <th key={m} className={THR}>{periodColumnLabel(m, months)}</th>)}</tr></thead>
          <tbody>
            <MiniMonth label="Sales achievement" months={months} values={months.map((m) => T.byMonth[m]?.ach ?? null)} kind="ach" />
            <MiniMonth label="Doctors reached" months={months} values={months.map((m) => T.customersByMonth[m] ?? 0)} kind="num" />
          </tbody>
        </table>
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
                <span>Doctors <b className="text-foreground">{numOrNA(d.customersTotal, d.visitsAvailable)}</b></span>
                <span>Doubles <b className="text-foreground">{numOrNA(d.doubleVisits, d.visitsAvailable)}</b></span>
              </div>
            </div>
            <div className="grid gap-3 p-3 lg:grid-cols-[1.6fr_1fr]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[440px] border-collapse">
                  <thead><tr className="border-b border-border"><th className={TH}>Monthly</th>{months.map((m) => <th key={m} className={THR}>{periodColumnLabel(m, months)}</th>)}</tr></thead>
                  <tbody>
                    <MiniMonth label="Achievement" months={months} values={months.map((m) => d.achByMonth?.[m] ?? null)} kind="ach" />
                    {d.visitsAvailable && <MiniMonth label="Visits" months={months} values={months.map((m) => d.visitsByMonth?.[m] ?? 0)} kind="num" />}
                    {d.visitsAvailable && <MiniMonth label="Doctors" months={months} values={months.map((m) => d.customersByMonth?.[m] ?? 0)} kind="num" />}
                  </tbody>
                </table>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[240px] border-collapse">
                  <thead><tr className="border-b border-border"><th className={TH}>{useFamily ? "Family mix" : "Product mix"}</th><th className={THR}>Achievement</th></tr></thead>
                  <tbody>
                    {mixRows.map((r) => (
                      <tr key={r.label} className="border-b border-border/50 last:border-0">
                        <td className={cn(TD, "font-medium")}>{r.label}</td>
                        <td className={TDR}>{achCell(r.ach)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })}

      {/* Kept as three separate tables: the lines share no products, so a single merged
          product table would imply a common catalogue that does not exist. */}
      {productTables.map((pt) => (
        <Section key={pt.id} title={`${pt.label} — achievement per product per month`} note="★ include products">
          <table className="w-full min-w-[720px] border-collapse">
            <thead><tr className="border-b border-border"><th className={TH}>Product</th>{months.map((m) => <th key={m} className={THR}>{periodColumnLabel(m, months)}</th>)}<th className={THR}>Total</th></tr></thead>
            <tbody>
              {pt.products.map((p) => (
                <tr key={p.product} className="border-b border-border/60 last:border-0">
                  <td className={cn(TD, "font-medium")}>{p.include && <span className="mr-1 text-amber-500">★</span>}{p.product}</td>
                  {months.map((m) => <td key={m} className={TDR}>{achCell(p.byMonth[m]?.ach ?? null)}</td>)}
                  <td className={cn(TDR, "font-bold")}>{achCell(p.total.ach)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
        }))}
        months={months}
        showLine
        visitsAvailable={customersOk}
      />

      <RoleActivityTable roles={company.roles} />
      <PeopleActivityTable people={company.people} />
    </div>
  );
}
