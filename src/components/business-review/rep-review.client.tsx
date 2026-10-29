"use client";

// Business Review — the MEDICAL REP's own frontend, built from scratch for him (owner, 2026-09-30:
// "med reps need a from scratch build to business review frontend tailored for them").
//
// This is deliberately NOT BusinessReviewPortal. That component is the manager's dashboard — line
// comparison, a district-manager league table, vacant-area and performance-gap tabs, an
// exclude-vacant toggle. None of it means anything to a rep, who has no team, no districts and no
// line to consolidate. Reusing it "scoped" is what left a rep scrolling a manager's page looking
// for four cards that concerned him.
//
// PHOENIX CRM GOLDEN RULE #1 — the rep's app is EASY, and it is BLIND (AGENTS.md §4). So this page:
//   - shows him ONLY his own scope: his areas, his products, his months, his own field activity;
//   - carries NO integrity signal of any kind — no mock-location flag, no "far from the place", no
//     accuracy or duplicate badge. Those live on the Super-Admin integrity board and nowhere a rep
//     can see them;
//   - is a plain, single-column stack of cards on a phone, a light grid on desktop. Nothing to
//     configure, nothing that reads as a checkpoint.
//
// EVERY NUMBER IS THE MONTHLY CLOSING'S OWN (the one sales+target truth, AGENTS.md §4). Achievement
// is sum(graded)/sum(target) across his areas — never an average of per-area percentages, never
// sum(sales)/sum(target). The visit split (AM · PM · Pharmacies) is additive and so is summed; the
// customer counts are UNIONS, not sums (a doctor in two of his areas is one doctor), so they are
// only ever shown PER AREA, never added into a headline that would double him.
//
// The full PDF / Excel / PowerPoint export is the same PackPicker the rest of the module uses,
// rendered by the page at level "rep" and passed in here.

import { useMemo } from "react";

import {
  PortalDesktopTable,
  PortalMetricCard,
  PortalResponsiveDataList,
  PortalSection,
  portalSubtlePanelClassName,
} from "@/components/employee-portal/portal-primitives";
import { figureWindowLabel, hasFigures, type ReviewCoverage } from "@/lib/business-review/coverage";
import type { ConcentrationFacts } from "@/lib/business-review/concentration";
import type { ReviewWindow } from "@/lib/business-review/period";
import { periodColumnLabel } from "@/lib/business-review/period-format";
import type { AreaSummary, Slice } from "@/lib/business-review/types";
import {
  emptyVisitCountSplit,
  formatVisitCountSplit,
  mergeVisitCountSplits,
  pharmacyTileFigure,
} from "@/lib/crm/visit-count-buckets";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import { cn } from "@/lib/utils";

import { ConcentrationPanels } from "./concentration.client";
import type { HiddenFields } from "./hidden-fields";
import { ReviewPeriodFilter } from "./review-filter.client";

/** His area rows already carry the locked-curve band/payout, mapped server-side. */
type RepAreaRow = AreaSummary & { payoutPct: number; band: string };

type Props = {
  /** His areas, already scoped to him and band-stamped server-side. */
  areas: RepAreaRow[];
  /** His line's incentive-included products, in catalogue order. */
  keyProducts: string[];
  /** Period keys in window order; render them with periodColumnLabel. */
  months: string[];
  /** Where his money came from — bricks, customers, channel. Null when not loaded. */
  concentration: ConcentrationFacts | null;
  coverage: ReviewCoverage;
  window: ReviewWindow;
  available: string[];
  mapGeneratedAt: string;
  visitsAvailable: boolean;
  lineLabel: string;
  headline: string;
  scopeLabel: string;
  /** The export chooser (PDF / Excel / PowerPoint), rendered by the page at level "rep". */
  picker?: React.ReactNode;
  /** Params the period filter must carry so changing the window keeps his scope. */
  windowHidden?: HiddenFields;
};

/* ---------- formatting (matches portal-review.client) ---------- */

const egp = (n: number) =>
  stableCurrencyFormatter("en-US", { currency: "EGP", maximumFractionDigits: 0, style: "currency" }).format(
    Number.isFinite(n) ? n : 0,
  );
const pct = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);
const num = (n: number | null | undefined) => (n != null && Number.isFinite(n) ? n.toLocaleString("en-US") : "0");
const numOrNA = (n: number | null | undefined, available: boolean) => (available ? num(n) : "no data");
/** AM · PM · Pharmacies — middle dot, never a slash, and a pharmacy is never a PM doctor (owner golden rule). */
const splitOf = (row: { am: number; pm: number; pharmacies: number }) => formatVisitCountSplit(row);

function achClass(a: number | null) {
  if (a == null) return "text-slate-400";
  if (a >= 100) return "text-emerald-700";
  if (a >= 90) return "text-emerald-600";
  if (a >= 70) return "text-amber-600";
  if (a >= 40) return "text-orange-600";
  return "text-rose-600";
}
const Ach = ({ value }: { value: number | null }) => (
  <span className={cn("font-black tabular-nums", achClass(value))}>{pct(value)}</span>
);

const TH = "break-words px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500";
const THR = `${TH} text-right`;
const TD = "px-3 py-1.5 text-sm font-semibold leading-tight text-slate-800";
const TDR = `${TD} text-right tabular-nums`;
const HEAD = "border-b border-slate-200 bg-slate-50/70";
const ROW = "border-b border-slate-100 last:border-0";
const FIELD = "rounded border border-slate-100 bg-slate-50 px-2.5 py-2";
const FIELD_LABEL = "text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400";

function Fields({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="mt-2.5 grid grid-cols-2 gap-2">
      {items.map((item) => (
        <div className={FIELD} key={item.label}>
          <dt className={FIELD_LABEL}>{item.label}</dt>
          <dd className="mt-0.5 min-w-0 break-words text-xs font-bold text-slate-800">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Sum a bag of slices the closing's way: add the parts, divide once. A percentage is never averaged. */
function sumSlices(slices: (Slice | undefined)[]): Slice {
  let sales = 0;
  let target = 0;
  let graded = 0;
  for (const s of slices) {
    if (!s) continue;
    sales += s.sales;
    target += s.target;
    graded += s.graded;
  }
  return { ach: target > 0 ? (100 * graded) / target : null, graded, sales, target };
}

export function RepBusinessReview({
  areas,
  keyProducts,
  months,
  concentration,
  coverage,
  window: reviewWindow,
  available,
  mapGeneratedAt,
  visitsAvailable,
  lineLabel,
  headline,
  scopeLabel,
  picker = null,
  windowHidden,
}: Props) {
  const customersOk = hasFigures(coverage, "customers");

  // His headline, summed the closing's way from the areas he was granted.
  const totals = useMemo(() => sumSlices(areas.map((a) => a.allProducts)), [areas]);

  // His products, each summed across his own areas — his mix, not the line's.
  const products = useMemo(
    () =>
      keyProducts
        .map((product) => ({ product, total: sumSlices(areas.map((a) => a.products?.[product])) }))
        .filter((row) => row.total.target > 0 || row.total.sales > 0),
    [areas, keyProducts],
  );
  const productsOnTarget = products.filter((p) => (p.total.ach ?? 0) >= 90).length;

  // His month-by-month sales — the include-only trend, added across areas position by position.
  const trend = useMemo(
    () => months.map((_, i) => areas.reduce((sum, a) => sum + (a.trend[i] ?? 0), 0)),
    [areas, months],
  );

  // Field activity. The visit split is additive; the per-month visit series is additive; both are
  // safe to sum. Customer counts are unions and stay PER AREA below.
  const visits = useMemo(() => {
    const total = areas.reduce((sum, a) => sum + a.visits, 0);
    // Merged by the golden-rule helper, so the share of Phoenix CRM visits travels with the sum and
    // the pharmacy figure of a team that works in Phoenix CRM is never printed as 0.
    const split = areas.reduce((acc, a) => mergeVisitCountSplits(acc, a.visitSplit), emptyVisitCountSplit());
    const byMonth = months.map((m) => areas.reduce((sum, a) => sum + (a.visitsByMonth[m] ?? 0), 0));
    return { byMonth, split, total };
  }, [areas, months]);

  const pharmacyTile = pharmacyTileFigure(visits.split, { formatNumber: (value) => num(value) });

  const sortedAreas = useMemo(
    () => areas.slice().sort((a, b) => (b.allProducts.ach ?? -1) - (a.allProducts.ach ?? -1)),
    [areas],
  );

  const windowLabel = figureWindowLabel(coverage);

  return (
    <div className="space-y-4">
      {/* ---------- header ---------- */}
      <div className={cn(portalSubtlePanelClassName, "space-y-3 p-4")}>
        <div className="min-w-0">
          <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-orange-600">My review · read-only</p>
          <h2 className="mt-1 text-lg font-black tracking-tight text-slate-950 sm:text-xl">{headline}</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            {lineLabel} · my {num(areas.length)} area{areas.length === 1 ? "" : "s"} · {windowLabel}
          </p>
        </div>
        <ReviewPeriodFilter
          action="/employee-portals/business-review"
          available={available}
          from={reviewWindow.from}
          hidden={windowHidden}
          to={reviewWindow.to}
        />
      </div>

      {/* The rep's page stays plain (golden rule #1). The manager's restatement disclaimer and the
          full coverage banner — direct-orders held out, EGP and row counts, marketing-missing
          caveats — are noise to him. The one thing worth a line is when his figures stop short of
          the window he picked because later months' sales have not landed yet; the header already
          names the span, so this only explains WHY, and only when it is narrower. */}
      {coverage.figureWindow ? (
        <p className="border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold leading-5 text-slate-500">
          These figures cover {windowLabel} — later months are left out because their distributor
          sales have not arrived yet.
        </p>
      ) : null}

      {picker}

      {/* ---------- his headline numbers ---------- */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <PortalMetricCard
          accent={(totals.ach ?? 0) >= 90 ? "emerald" : "rose"}
          label="My achievement"
          note={`all products · ${windowLabel}, period to date`}
          value={pct(totals.ach)}
        />
        <PortalMetricCard accent="sky" label="My sales" note={`of ${egp(totals.target)}`} value={egp(totals.sales)} />
        <PortalMetricCard
          accent="orange"
          label="My visits"
          note={visitsAvailable ? `AM · PM · Pharmacies ${splitOf(visits.split)}` : "no visits recorded"}
          value={numOrNA(visits.total, visitsAvailable)}
        />
        <PortalMetricCard
          accent="emerald"
          label="Products ≥ 90%"
          note={`of ${num(products.length)} products`}
          value={num(productsOnTarget)}
        />
      </section>

      {/* ---------- my products ---------- */}
      <PortalSection
        description="How each product I sell is doing against its own target, added across my areas."
        eyebrow="My products"
        title="Product achievement"
      >
        <PortalResponsiveDataList
          empty={<div className="px-4 py-6 text-sm font-semibold text-slate-500">No product carried a target or sales in this window.</div>}
          getKey={(row) => row.product}
          items={products}
          renderCard={(row) => (
            <div className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <h3 className="min-w-0 break-words text-sm font-black text-slate-950">{row.product}</h3>
                <Ach value={row.total.ach} />
              </div>
              <p className="mt-1 text-xs font-semibold text-slate-500">
                {egp(row.total.sales)} of {egp(row.total.target)}
              </p>
            </div>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[40%]" />
                  <col className="w-[20%]" />
                  <col className="w-[20%]" />
                  <col className="w-[20%]" />
                </colgroup>
              }
            >
              <thead>
                <tr className={HEAD}>
                  <th className={TH}>Product</th>
                  <th className={TH}>Achievement</th>
                  <th className={THR}>Sales</th>
                  <th className={THR}>Target</th>
                </tr>
              </thead>
              <tbody>
                {products.map((row) => (
                  <tr className={ROW} key={row.product}>
                    <td className={cn(TD, "font-black")}>{row.product}</td>
                    <td className={TD}>
                      <Ach value={row.total.ach} />
                    </td>
                    <td className={TDR}>{egp(row.total.sales)}</td>
                    <td className={cn(TDR, "text-slate-500")}>{egp(row.total.target)}</td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </PortalSection>

      {/* ---------- my areas ---------- */}
      <PortalSection
        description="Each area I stand in, ranked by achievement. Customers are counted per area — a doctor in two of my areas is one doctor in each."
        eyebrow="My territory"
        title={`My areas (${num(areas.length)})`}
      >
        <PortalResponsiveDataList
          empty={<div className="px-4 py-6 text-sm font-semibold text-slate-500">No area in scope.</div>}
          getKey={(row) => row.area}
          items={sortedAreas}
          renderCard={(row) => (
            <div className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="min-w-0 break-words text-sm font-black text-slate-950">{row.area}</h3>
                  <p className="mt-0.5 text-xs font-semibold text-slate-500">{row.region}</p>
                </div>
                <Ach value={row.allProducts.ach} />
              </div>
              <Fields
                items={[
                  { label: "Sales", value: egp(row.allProducts.sales) },
                  { label: "Target", value: egp(row.allProducts.target) },
                  { label: "Visits", value: numOrNA(row.visits, visitsAvailable) },
                  { label: "Customers", value: numOrNA(row.customersTotal, customersOk) },
                ]}
              />
            </div>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[24%]" />
                  <col className="w-[16%]" />
                  <col className="w-[14%]" />
                  <col className="w-[16%]" />
                  <col className="w-[16%]" />
                  <col className="w-[14%]" />
                </colgroup>
              }
            >
              <thead>
                <tr className={HEAD}>
                  <th className={TH}>Area</th>
                  <th className={TH}>Region</th>
                  <th className={TH}>Achievement</th>
                  <th className={THR}>Sales</th>
                  <th className={THR}>Target</th>
                  <th className={THR}>Customers</th>
                </tr>
              </thead>
              <tbody>
                {sortedAreas.map((row) => (
                  <tr className={cn(ROW, (row.allProducts.ach ?? 0) >= 90 && "bg-emerald-50/40")} key={row.area}>
                    <td className={cn(TD, "font-black")}>{row.area}</td>
                    <td className={cn(TD, "text-xs text-slate-500")}>{row.region}</td>
                    <td className={TD}>
                      <Ach value={row.allProducts.ach} />
                    </td>
                    <td className={TDR}>{egp(row.allProducts.sales)}</td>
                    <td className={cn(TDR, "text-slate-500")}>{egp(row.allProducts.target)}</td>
                    <td className={TDR}>{numOrNA(row.customersTotal, customersOk)}</td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </PortalSection>

      {/* ---------- my monthly trend ---------- */}
      <PortalSection description={`My sales value across ${num(months.length)} months.`} eyebrow="Trend" title="Month by month">
        <dl className="grid grid-cols-3 gap-2 p-4 sm:grid-cols-4 lg:grid-cols-6">
          {months.map((month, index) => (
            <div className={FIELD} key={month}>
              <dt className={FIELD_LABEL}>{periodColumnLabel(month, months)}</dt>
              <dd
                className={cn(
                  "mt-0.5 break-words text-xs font-bold",
                  (trend[index] ?? 0) < 0 ? "text-rose-700" : "text-slate-800",
                )}
              >
                {egp(trend[index] ?? 0)}
              </dd>
            </div>
          ))}
        </dl>
      </PortalSection>

      {/* ---------- my field activity ---------- */}
      <PortalSection
        description="My own field work — what I did, never a check on me. AM · PM · Pharmacies are three figures apart, never a combined rate."
        eyebrow="My activity"
        title="Field activity"
      >
        {visitsAvailable ? (
          <div className="space-y-3 p-4">
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className={FIELD}>
                <dt className={FIELD_LABEL}>Total visits</dt>
                <dd className="mt-0.5 text-xl font-black tabular-nums text-slate-950">{num(visits.total)}</dd>
              </div>
              <div className={FIELD}>
                <dt className={FIELD_LABEL}>AM</dt>
                <dd className="mt-0.5 text-xl font-black tabular-nums text-slate-950">{num(visits.split.am)}</dd>
              </div>
              <div className={FIELD}>
                <dt className={FIELD_LABEL}>PM (doctors)</dt>
                <dd className="mt-0.5 text-xl font-black tabular-nums text-slate-950">{num(visits.split.pm)}</dd>
              </div>
              <div className={FIELD}>
                <dt className={FIELD_LABEL}>Pharmacies</dt>
                <dd className="mt-0.5 text-xl font-black tabular-nums text-slate-950">{pharmacyTile.value}</dd>
                {/* Phoenix CRM logs no pharmacy visit: "Not recorded", never 0 (visit-count-buckets.ts). */}
                {pharmacyTile.note ? <dd className="mt-0.5 text-phx-2xs font-semibold text-slate-500">{pharmacyTile.note}</dd> : null}
              </div>
            </dl>
            <dl className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {months.map((month, index) => (
                <div className={FIELD} key={month}>
                  <dt className={FIELD_LABEL}>{periodColumnLabel(month, months)}</dt>
                  <dd className="mt-0.5 break-words text-xs font-bold text-slate-800">{num(visits.byMonth[index] ?? 0)} visits</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : (
          <div className="px-4 py-6 text-sm font-semibold text-slate-500">No field visits were recorded in this window.</div>
        )}
      </PortalSection>

      {/* ---------- where my sales came from ---------- */}
      {concentration ? (
        <PortalSection
          description="My top bricks, my top customers, and how the money reached the market."
          eyebrow="Where it came from"
          title="My sales sources"
        >
          <div className="p-4">
            <ConcentrationPanels facts={concentration} scopeNote={scopeLabel} />
          </div>
        </PortalSection>
      ) : null}

      <p className="px-1 text-phx-xs font-semibold leading-5 text-slate-400">
        My territory is resolved from the live organogram, read {mapGeneratedAt.slice(0, 10)}. Figures are the actuals
        for {windowLabel} and are not restated when a seat changes hands.
      </p>
    </div>
  );
}
