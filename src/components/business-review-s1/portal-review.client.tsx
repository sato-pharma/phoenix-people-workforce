"use client";

import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalMetricCard,
  PortalResponsiveDataList,
  PortalSection,
  PortalSegmentedTabs,
  portalSubtlePanelClassName,
} from "@/components/employee-portal/portal-primitives";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { AreaSummary, CompanyLineRow, DmSummary, ProductRow } from "@/lib/business-review-s1/types";

/**
 * S1 Business Review — the employee-portal view, at every scope breadth.
 *
 * Deliberately NOT the admin dashboard, for two reasons:
 *
 *  1. The admin dashboard's KPI row reads `ds.line.*` — the whole line's sales, target,
 *     marketing and visits. Rendering it for a District Manager would show them their entire
 *     line. Every figure here is summed from the rows the viewer was actually granted, so
 *     there is no line-level number on the page that could leak.
 *  2. The portal has a standing design rule that a data table must never horizontal-scroll on
 *     mobile. Every table below is desktop-only with a stacked-card fallback under `md`, via
 *     PortalResponsiveDataList.
 */

type PortalAreaRow = AreaSummary & { payoutPct: number; band: string; line?: string };
type PortalDmRow = DmSummary & {
  payoutPct: number;
  band: string;
  line?: string;
  visitsAvailable?: boolean;
  keyProducts?: string[];
  families?: string[];
};

type Props = {
  headline: string;
  scopeLabel: string;
  months: string[];
  /** Already scoped to this viewer, before any ranking or truncation (PR #1487). */
  areas: PortalAreaRow[];
  dms: PortalDmRow[];
  /** Per-product columns. Empty at company breadth, where the three catalogues differ. */
  keyProducts: string[];
  /** Per-line product tables. Empty for an area-scoped viewer. */
  productTables: { id: string; label: string; products: ProductRow[] }[];
  /** Cross-line comparison. Company breadth only. */
  lineRows: CompanyLineRow[];
  thresholds: { repFailBelow: number; dsmFailBelow: number };
  /** Rebuilt from canonical SoS — see canonical.ts's S1_RESTATEMENT_NOTICE. Shown on every
   *  scope breadth; H1 incentives were paid against the retired sales engine and are closed. */
  restatementNotice: string;
  mapGeneratedAt: string;
  /** Fallback when a DM row carries no own flag (single-line scopes). */
  visitsAvailable: boolean;
};

/* ---------- formatting ---------- */

const egp = (n: number) =>
  new Intl.NumberFormat("en-US", { currency: "EGP", maximumFractionDigits: 0, style: "currency" }).format(
    Number.isFinite(n) ? n : 0,
  );
const pct = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);
const num = (n: number | null | undefined) => (n != null && Number.isFinite(n) ? n.toLocaleString("en-US") : "0");
/** "N/A", never a misleading 0, when the line has no CRM visits export at all. */
const numOrNA = (n: number | null | undefined, available: boolean) => (available ? num(n) : "N/A");

function achClass(a: number | null) {
  if (a == null) return "text-slate-400";
  if (a >= 100) return "text-emerald-700";
  if (a >= 90) return "text-emerald-600";
  if (a >= 70) return "text-amber-600";
  if (a >= 40) return "text-orange-600";
  return "text-rose-600";
}
const Ach = ({ value }: { value: number | null }) => (
  <span className={cn("whitespace-nowrap font-black tabular-nums", achClass(value))}>{pct(value)}</span>
);

const BAND_STYLE: Record<string, string> = {
  elite: "border-emerald-200 bg-emerald-50 text-emerald-700",
  "not-eligible": "border-slate-200 bg-slate-50 text-slate-500",
  "on-target": "border-sky-200 bg-sky-50 text-sky-700",
  "over-achiever": "border-teal-200 bg-teal-50 text-teal-700",
  threshold: "border-amber-200 bg-amber-50 text-amber-700",
};
const BAND_TEXT: Record<string, string> = {
  elite: "Elite 150%+",
  "not-eligible": "Below 90%",
  "on-target": "On target",
  "over-achiever": "120–150%",
  threshold: "90–100%",
};
const Band = ({ band }: { band: string }) => (
  <span
    className={cn(
      "inline-flex whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-black uppercase tracking-[0.08em]",
      BAND_STYLE[band] ?? BAND_STYLE["not-eligible"],
    )}
  >
    {BAND_TEXT[band] ?? band}
  </span>
);
const Tag = ({ children, tone }: { children: React.ReactNode; tone: "slate" | "rose" }) => (
  <span
    className={cn(
      "inline-flex whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-black uppercase tracking-[0.08em]",
      tone === "rose" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-slate-200 bg-slate-50 text-slate-500",
    )}
  >
    {children}
  </span>
);

const TH = "whitespace-nowrap px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500";
const THR = `${TH} text-right`;
const TD = "whitespace-nowrap px-3 py-2.5 text-sm font-semibold text-slate-800";
const TDR = `${TD} text-right tabular-nums`;
const HEAD = "border-b border-slate-200 bg-slate-50/70";
const ROW = "border-b border-slate-100 last:border-0";
const FIELD = "rounded border border-slate-100 bg-slate-50 px-2.5 py-2";
const FIELD_LABEL = "text-[10px] font-black uppercase tracking-[0.12em] text-slate-400";

const TABS = [
  { id: "performance", label: "Performance" },
  { id: "gaps", label: "Performance Gaps" },
  { id: "detail", label: "Detail" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Fields({ items }: { items: { label: string; value: string }[] }) {
  return (
    <dl className="mt-2.5 grid grid-cols-2 gap-2">
      {items.map((item) => (
        <div className={FIELD} key={item.label}>
          <dt className={FIELD_LABEL}>{item.label}</dt>
          <dd className="mt-0.5 whitespace-nowrap text-xs font-bold text-slate-800">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------- component ---------- */

export function S1PortalReview({
  areas,
  restatementNotice,
  dms,
  headline,
  keyProducts,
  lineRows,
  mapGeneratedAt,
  months,
  productTables,
  scopeLabel,
  thresholds,
  visitsAvailable,
}: Props) {
  const [tab, setTab] = useState<TabId>("performance");
  const [excludeVacant, setExcludeVacant] = useState(false);

  // Achievement is ALWAYS computed on every granted area — the toggle only hides vacant rows
  // from the lists, it never changes a percentage. And it is sum(sales)/sum(target), never an
  // average of the per-area percentages.
  const totals = useMemo(() => {
    const sales = areas.reduce((sum, a) => sum + a.allProducts.sales, 0);
    const target = areas.reduce((sum, a) => sum + a.allProducts.target, 0);
    const spend = dms.reduce((sum, d) => sum + d.marketingCost + d.outstationCost, 0);
    return { ach: target > 0 ? (100 * sales) / target : null, sales, spend, target };
  }, [areas, dms]);

  const graded = useMemo(() => areas.filter((a) => a.hasTarget && a.allProducts.ach != null), [areas]);
  const earners = useMemo(() => graded.filter((a) => !a.vacant && (a.allProducts.ach ?? 0) >= 90), [graded]);
  const vacantAreas = useMemo(() => areas.filter((a) => a.vacant), [areas]);
  const failAreas = useMemo(
    () =>
      graded
        .filter((a) => !a.vacant && (a.allProducts.ach ?? 0) < thresholds.repFailBelow)
        .sort((a, b) => (a.allProducts.ach ?? 0) - (b.allProducts.ach ?? 0)),
    [graded, thresholds.repFailBelow],
  );

  const visibleAreas = useMemo(
    () =>
      (excludeVacant ? areas.filter((a) => !a.vacant) : areas)
        .slice()
        .sort((a, b) => (b.allProducts.ach ?? -1) - (a.allProducts.ach ?? -1)),
    [areas, excludeVacant],
  );
  const visibleDms = useMemo(
    () =>
      (excludeVacant ? dms.filter((d) => !d.vacant) : dms)
        .filter((d) => d.allProducts.target > 0)
        .slice()
        .sort((a, b) => (b.allProducts.ach ?? -1) - (a.allProducts.ach ?? -1)),
    [dms, excludeVacant],
  );
  const failDms = useMemo(
    () =>
      visibleDms
        .filter((d) => !d.vacant && (d.allProducts.ach ?? 0) < thresholds.dsmFailBelow)
        .slice()
        .sort((a, b) => (a.allProducts.ach ?? 0) - (b.allProducts.ach ?? 0)),
    [visibleDms, thresholds.dsmFailBelow],
  );

  const showLines = lineRows.length > 1;
  const showDms = dms.length > 1;
  const visitsOf = (row: PortalDmRow) => row.visitsAvailable ?? visitsAvailable;
  const areaKey = (row: PortalAreaRow) => `${row.line ?? ""}:${row.area}`;
  const dmKey = (row: PortalDmRow) => `${row.line ?? ""}:${row.dm}`;
  const nothing = (message: string) => <PortalEmptyState message={message} title="Nothing to show" />;

  return (
    <div className="space-y-4">
      {/* ---------- header ---------- */}
      <div className={cn(portalSubtlePanelClassName, "flex flex-col gap-3 p-4 sm:flex-row sm:items-end sm:justify-between")}>
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-orange-600">My scope · read-only</p>
          <h2 className="mt-1 text-lg font-black tracking-tight text-slate-950 sm:text-xl">{headline}</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            {scopeLabel} · {num(areas.length)} area{areas.length === 1 ? "" : "s"} · ≥90% earns
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2.5 rounded border border-slate-200 bg-white px-3 py-2">
          <Switch checked={excludeVacant} label="Exclude vacant territories" onChange={setExcludeVacant} />
          <span className="whitespace-nowrap text-sm font-bold text-slate-700">Exclude vacant</span>
        </label>
      </div>

      <div className="flex items-start gap-2.5 rounded border border-amber-200 bg-amber-50 p-4">
        <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <p className="text-xs font-semibold leading-5 text-amber-900">{restatementNotice}</p>
      </div>

      {/* ---------- KPIs, summed from the granted rows only ----------
          No icons: the owner's portal design rule is monochrome, functional cards — a thin
          accent left-border only, no decorative icon badges. */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <PortalMetricCard
          accent={(totals.ach ?? 0) >= 90 ? "emerald" : "rose"}
          label="My achievement"
          note="my areas · all products"
          value={pct(totals.ach)}
        />
        <PortalMetricCard accent="sky" label="My sales" note={`of ${egp(totals.target)}`} value={egp(totals.sales)} />
        <PortalMetricCard accent="emerald" label="Earners ≥ 90%" note={`of ${num(graded.length)} graded areas`} value={num(earners.length)} />
        <PortalMetricCard accent="rose" label={`Below ${thresholds.repFailBelow}%`} note="vacant areas excluded" value={num(failAreas.length)} />
        <PortalMetricCard accent="slate" label="Vacant areas" note="coverage gap, not a failure" value={num(vacantAreas.length)} />
        <PortalMetricCard accent="amber" label="Marketing + outstation" note="approved spend in my scope" value={egp(totals.spend)} />
      </section>

      <PortalSegmentedTabs>
        {TABS.map((t) => (
          <button
            className={cn(
              "flex-1 whitespace-nowrap rounded px-3 py-2 text-sm font-bold transition",
              tab === t.id ? "bg-white text-slate-950 shadow-[0_1px_3px_rgba(15,23,42,0.12)]" : "text-slate-500 hover:text-slate-800",
            )}
            key={t.id}
            onClick={() => setTab(t.id)}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </PortalSegmentedTabs>

      {/* ================= PERFORMANCE ================= */}
      {tab === "performance" ? (
        <div className="space-y-4">
          {showLines ? (
            <PortalSection
              description="Achievement is sum(sales)/sum(target) per line — never an average of percentages."
              eyebrow="Consolidated"
              title="Line comparison"
            >
              <PortalResponsiveDataList
                empty={nothing("No line in scope.")}
                getKey={(row) => row.id}
                items={lineRows}
                renderCard={(row) => (
                  <div className="px-4 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="whitespace-nowrap text-sm font-black text-slate-950">{row.label}</h3>
                      <Ach value={row.allProducts.ach} />
                    </div>
                    <Fields
                      items={[
                        { label: "Sales", value: egp(row.allProducts.sales) },
                        { label: "Target", value: egp(row.allProducts.target) },
                        { label: "Earners", value: num(row.earners) },
                        { label: "Areas", value: `${num(row.areas)} · ${num(row.areasVacant)} vacant` },
                        { label: "Marketing", value: egp(row.marketingCost) },
                        { label: "Doctors", value: numOrNA(row.customersTotal, row.visitsAvailable) },
                      ]}
                    />
                  </div>
                )}
                renderTable={() => (
                  <PortalDesktopTable minWidth="900px">
                    <thead>
                      <tr className={HEAD}>
                        <th className={TH}>Line</th>
                        <th className={TH}>Achievement</th>
                        <th className={THR}>Sales</th>
                        <th className={THR}>Target</th>
                        <th className={THR}>Earners</th>
                        <th className={THR}>Areas</th>
                        <th className={THR}>Vacant</th>
                        <th className={THR}>Marketing</th>
                        <th className={THR}>Doctors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineRows.map((row) => (
                        <tr className={ROW} key={row.id}>
                          <td className={cn(TD, "font-black")}>{row.label}</td>
                          <td className={TD}>
                            <Ach value={row.allProducts.ach} />
                          </td>
                          <td className={TDR}>{egp(row.allProducts.sales)}</td>
                          <td className={cn(TDR, "text-slate-500")}>{egp(row.allProducts.target)}</td>
                          <td className={TDR}>{num(row.earners)}</td>
                          <td className={TDR}>{num(row.areas)}</td>
                          <td className={cn(TDR, "text-slate-500")}>{num(row.areasVacant)}</td>
                          <td className={cn(TDR, "text-slate-500")}>{egp(row.marketingCost)}</td>
                          <td className={TDR}>{numOrNA(row.customersTotal, row.visitsAvailable)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </PortalDesktopTable>
                )}
              />
            </PortalSection>
          ) : null}

          {showDms ? (
            <PortalSection
              description="All-products achievement mapped onto the locked 2026 payout curve."
              eyebrow="My team"
              title={`District managers (${num(visibleDms.length)})`}
            >
              <PortalResponsiveDataList
                empty={nothing("No district in scope.")}
                getKey={dmKey}
                items={visibleDms}
                renderCard={(row) => (
                  <div className="px-4 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="whitespace-nowrap text-sm font-black text-slate-950">{row.dm}</h3>
                        <p className="mt-0.5 text-xs font-semibold text-slate-500">
                          {row.line ? `${row.line} · ` : ""}
                          {row.region}
                        </p>
                      </div>
                      <Ach value={row.allProducts.ach} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Band band={row.band} />
                      {row.vacant ? <Tag tone="slate">Vacant</Tag> : null}
                    </div>
                    <Fields
                      items={[
                        { label: "Payout", value: row.payoutPct > 0 ? `${row.payoutPct.toFixed(0)}%` : "—" },
                        { label: "Sales", value: egp(row.allProducts.sales) },
                        { label: "Target", value: egp(row.allProducts.target) },
                        { label: "Areas", value: num(row.areas.length) },
                        { label: "Visits/mo", value: numOrNA(row.visitsAvgPerMonth, visitsOf(row)) },
                        { label: "Doctors", value: numOrNA(row.customersTotal, visitsOf(row)) },
                      ]}
                    />
                  </div>
                )}
                renderTable={() => (
                  <PortalDesktopTable minWidth="1040px">
                    <thead>
                      <tr className={HEAD}>
                        <th className={TH}>District manager</th>
                        {showLines ? <th className={TH}>Line</th> : null}
                        <th className={TH}>Achievement</th>
                        <th className={TH}>Band</th>
                        <th className={THR}>Payout</th>
                        <th className={THR}>Sales</th>
                        <th className={THR}>Target</th>
                        <th className={THR}>Areas</th>
                        <th className={THR}>Visits/mo</th>
                        <th className={THR}>Doctors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleDms.map((row) => (
                        <tr className={cn(ROW, (row.allProducts.ach ?? 0) >= 90 && !row.vacant && "bg-emerald-50/40")} key={dmKey(row)}>
                          <td className={cn(TD, "font-black")}>
                            {row.dm}
                            {row.vacant ? (
                              <span className="ml-2 inline-flex">
                                <Tag tone="slate">Vacant</Tag>
                              </span>
                            ) : null}
                          </td>
                          {showLines ? <td className={cn(TD, "text-xs text-slate-500")}>{row.line}</td> : null}
                          <td className={TD}>
                            <Ach value={row.allProducts.ach} />
                          </td>
                          <td className={TD}>
                            <Band band={row.band} />
                          </td>
                          <td className={cn(TDR, "font-black")}>{row.payoutPct > 0 ? `${row.payoutPct.toFixed(0)}%` : "—"}</td>
                          <td className={TDR}>{egp(row.allProducts.sales)}</td>
                          <td className={cn(TDR, "text-slate-500")}>{egp(row.allProducts.target)}</td>
                          <td className={TDR}>{num(row.areas.length)}</td>
                          <td className={TDR}>{numOrNA(row.visitsAvgPerMonth, visitsOf(row))}</td>
                          <td className={TDR}>{numOrNA(row.customersTotal, visitsOf(row))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </PortalDesktopTable>
                )}
              />
            </PortalSection>
          ) : null}

          <PortalSection
            description="Ranked by achievement. A vacant area keeps its real number — it is a coverage gap, never an earner and never a rep failure."
            eyebrow="My territory"
            title={`Areas (${num(visibleAreas.length)})`}
          >
            <PortalResponsiveDataList
              empty={nothing("No area in scope.")}
              getKey={areaKey}
              items={visibleAreas}
              renderCard={(row) => (
                <div className="px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="whitespace-nowrap text-sm font-black text-slate-950">{row.area}</h3>
                      <p className="mt-0.5 text-xs font-semibold text-slate-500">
                        {row.line ? `${row.line} · ` : ""}
                        {row.dm}
                      </p>
                    </div>
                    <Ach value={row.allProducts.ach} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {row.vacant ? <Tag tone="slate">Vacant</Tag> : <Band band={row.band} />}
                    {row.hasReturns ? <Tag tone="rose">Returns</Tag> : null}
                    {!row.hasTarget && row.ungradeable ? <Tag tone="slate">No target</Tag> : null}
                  </div>
                  <Fields
                    items={[
                      { label: "Payout", value: row.vacant || row.payoutPct <= 0 ? "—" : `${row.payoutPct.toFixed(0)}%` },
                      { label: "Sales", value: egp(row.allProducts.sales) },
                      { label: "Target", value: egp(row.allProducts.target) },
                      { label: "Region", value: row.region },
                    ]}
                  />
                  {keyProducts.length > 0 ? (
                    <dl className="mt-2 grid grid-cols-2 gap-2">
                      {keyProducts.map((product) => (
                        <div className="rounded border border-slate-100 bg-white px-2.5 py-2" key={product}>
                          <dt className={cn(FIELD_LABEL, "whitespace-nowrap")}>{product}</dt>
                          <dd className="mt-0.5">
                            <Ach value={row.products?.[product]?.ach ?? null} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </div>
              )}
              renderTable={() => (
                <PortalDesktopTable minWidth={`${920 + keyProducts.length * 110}px`}>
                  <thead>
                    <tr className={HEAD}>
                      <th className={TH}>Area</th>
                      {showLines ? <th className={TH}>Line</th> : null}
                      <th className={TH}>District</th>
                      <th className={TH}>Achievement</th>
                      <th className={TH}>Band</th>
                      <th className={THR}>Payout</th>
                      <th className={THR}>Sales</th>
                      <th className={THR}>Target</th>
                      {keyProducts.map((product) => (
                        <th className={THR} key={product}>
                          {product}
                        </th>
                      ))}
                      <th className={TH}>Flag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleAreas.map((row) => (
                      <tr className={cn(ROW, (row.allProducts.ach ?? 0) >= 90 && !row.vacant && "bg-emerald-50/40")} key={areaKey(row)}>
                        <td className={cn(TD, "font-black")}>
                          {row.area}
                          {row.vacant ? (
                            <span className="ml-2 inline-flex">
                              <Tag tone="slate">Vacant</Tag>
                            </span>
                          ) : null}
                        </td>
                        {showLines ? <td className={cn(TD, "text-xs text-slate-500")}>{row.line}</td> : null}
                        <td className={cn(TD, "text-xs text-slate-500")}>{row.dm}</td>
                        <td className={TD}>
                          <Ach value={row.allProducts.ach} />
                        </td>
                        <td className={TD}>{row.vacant ? <span className="text-xs text-slate-400">—</span> : <Band band={row.band} />}</td>
                        <td className={cn(TDR, "font-black")}>{row.vacant || row.payoutPct <= 0 ? "—" : `${row.payoutPct.toFixed(0)}%`}</td>
                        <td className={TDR}>{egp(row.allProducts.sales)}</td>
                        <td className={cn(TDR, "text-slate-500")}>{egp(row.allProducts.target)}</td>
                        {keyProducts.map((product) => (
                          <td className={TDR} key={product}>
                            <Ach value={row.products?.[product]?.ach ?? null} />
                          </td>
                        ))}
                        <td className={TD}>
                          <span className="flex gap-1">
                            {row.hasReturns ? <Tag tone="rose">Returns</Tag> : null}
                            {!row.hasTarget && row.ungradeable ? <Tag tone="slate">No target</Tag> : null}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              )}
            />
          </PortalSection>
        </div>
      ) : null}

      {/* ================= PERFORMANCE GAPS ================= */}
      {tab === "gaps" ? (
        <div className="space-y-4">
          {showDms ? (
            <PortalSection eyebrow="Below threshold" title={`Districts under ${thresholds.dsmFailBelow}% (${num(failDms.length)})`}>
              <PortalResponsiveDataList
                empty={nothing(`No district in scope is below ${thresholds.dsmFailBelow}%.`)}
                getKey={dmKey}
                items={failDms}
                renderCard={(row) => (
                  <div className="px-4 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="whitespace-nowrap text-sm font-black text-slate-950">{row.dm}</h3>
                      <Ach value={row.allProducts.ach} />
                    </div>
                    <p className="mt-1 text-xs font-semibold text-slate-500">
                      Gap {egp(row.allProducts.target - row.allProducts.sales)} · {num(row.areas.length)} areas
                    </p>
                  </div>
                )}
                renderTable={() => (
                  <PortalDesktopTable minWidth="860px">
                    <thead>
                      <tr className={HEAD}>
                        <th className={TH}>District manager</th>
                        {showLines ? <th className={TH}>Line</th> : null}
                        <th className={TH}>Achievement</th>
                        <th className={THR}>Sales</th>
                        <th className={THR}>Target</th>
                        <th className={THR}>Gap</th>
                        <th className={THR}>Areas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {failDms.map((row) => (
                        <tr className={ROW} key={dmKey(row)}>
                          <td className={cn(TD, "font-black")}>{row.dm}</td>
                          {showLines ? <td className={cn(TD, "text-xs text-slate-500")}>{row.line}</td> : null}
                          <td className={TD}>
                            <Ach value={row.allProducts.ach} />
                          </td>
                          <td className={TDR}>{egp(row.allProducts.sales)}</td>
                          <td className={cn(TDR, "text-slate-500")}>{egp(row.allProducts.target)}</td>
                          <td className={cn(TDR, "font-black text-rose-700")}>{egp(row.allProducts.target - row.allProducts.sales)}</td>
                          <td className={TDR}>{num(row.areas.length)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </PortalDesktopTable>
                )}
              />
            </PortalSection>
          ) : null}

          <PortalSection
            description="Worst first. Vacant areas are excluded — an empty seat is a coverage gap, not a rep who underperformed."
            eyebrow="Below threshold"
            title={`Areas under ${thresholds.repFailBelow}% (${num(failAreas.length)})`}
          >
            <PortalResponsiveDataList
              empty={nothing(`No occupied area in scope is below ${thresholds.repFailBelow}%.`)}
              getKey={areaKey}
              items={failAreas}
              renderCard={(row) => (
                <div className="px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="whitespace-nowrap text-sm font-black text-slate-950">{row.area}</h3>
                      <p className="mt-0.5 text-xs font-semibold text-slate-500">{row.dm}</p>
                    </div>
                    <Ach value={row.allProducts.ach} />
                  </div>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    Gap {egp(row.allProducts.target - row.allProducts.sales)}
                    {row.hasReturns ? " · has returns" : ""}
                  </p>
                </div>
              )}
              renderTable={() => (
                <PortalDesktopTable minWidth="860px">
                  <thead>
                    <tr className={HEAD}>
                      <th className={TH}>Area</th>
                      {showLines ? <th className={TH}>Line</th> : null}
                      <th className={TH}>District</th>
                      <th className={TH}>Achievement</th>
                      <th className={THR}>Sales</th>
                      <th className={THR}>Target</th>
                      <th className={THR}>Gap</th>
                      <th className={TH}>Flag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failAreas.map((row) => (
                      <tr className={ROW} key={areaKey(row)}>
                        <td className={cn(TD, "font-black")}>{row.area}</td>
                        {showLines ? <td className={cn(TD, "text-xs text-slate-500")}>{row.line}</td> : null}
                        <td className={cn(TD, "text-xs text-slate-500")}>{row.dm}</td>
                        <td className={TD}>
                          <Ach value={row.allProducts.ach} />
                        </td>
                        <td className={TDR}>{egp(row.allProducts.sales)}</td>
                        <td className={cn(TDR, "text-slate-500")}>{egp(row.allProducts.target)}</td>
                        <td className={cn(TDR, "font-black text-rose-700")}>{egp(row.allProducts.target - row.allProducts.sales)}</td>
                        <td className={TD}>{row.hasReturns ? <Tag tone="rose">Returns</Tag> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              )}
            />
          </PortalSection>

          <PortalSection
            description="Listed separately so they never distort an earner count or a failure count."
            eyebrow="Coverage"
            title={`Vacant areas (${num(vacantAreas.length)})`}
          >
            <PortalResponsiveDataList
              empty={nothing("Every area in your scope is occupied.")}
              getKey={areaKey}
              items={vacantAreas}
              renderCard={(row) => (
                <div className="px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="whitespace-nowrap text-sm font-black text-slate-950">{row.area}</h3>
                      <p className="mt-0.5 text-xs font-semibold text-slate-500">{row.dm}</p>
                    </div>
                    <Ach value={row.allProducts.ach} />
                  </div>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    {egp(row.allProducts.sales)} of {egp(row.allProducts.target)}
                  </p>
                </div>
              )}
              renderTable={() => (
                <PortalDesktopTable minWidth="740px">
                  <thead>
                    <tr className={HEAD}>
                      <th className={TH}>Area</th>
                      {showLines ? <th className={TH}>Line</th> : null}
                      <th className={TH}>District</th>
                      <th className={TH}>Achievement</th>
                      <th className={THR}>Sales</th>
                      <th className={THR}>Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vacantAreas.map((row) => (
                      <tr className={ROW} key={areaKey(row)}>
                        <td className={cn(TD, "font-black")}>{row.area}</td>
                        {showLines ? <td className={cn(TD, "text-xs text-slate-500")}>{row.line}</td> : null}
                        <td className={cn(TD, "text-xs text-slate-500")}>{row.dm}</td>
                        <td className={TD}>
                          <Ach value={row.allProducts.ach} />
                        </td>
                        <td className={TDR}>{egp(row.allProducts.sales)}</td>
                        <td className={cn(TDR, "text-slate-500")}>{egp(row.allProducts.target)}</td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              )}
            />
          </PortalSection>
        </div>
      ) : null}

      {/* ================= DETAIL ================= */}
      {tab === "detail" ? (
        <div className="space-y-4">
          <PortalSection description={`${num(months.length)} months of sales value per area.`} eyebrow="Trend" title="Monthly sales">
            <PortalResponsiveDataList
              empty={nothing("No area in scope.")}
              getKey={areaKey}
              items={visibleAreas}
              renderCard={(row) => (
                <div className="px-4 py-3.5">
                  <h3 className="whitespace-nowrap text-sm font-black text-slate-950">{row.area}</h3>
                  <dl className="mt-2 grid grid-cols-3 gap-2">
                    {months.map((month, index) => (
                      <div className="rounded border border-slate-100 bg-slate-50 px-2 py-1.5" key={month}>
                        <dt className={FIELD_LABEL}>{month}</dt>
                        <dd
                          className={cn(
                            "mt-0.5 whitespace-nowrap text-xs font-bold",
                            (row.trend[index] ?? 0) < 0 ? "text-rose-700" : "text-slate-800",
                          )}
                        >
                          {egp(row.trend[index] ?? 0)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
              renderTable={() => (
                <PortalDesktopTable minWidth={`${300 + months.length * 120}px`}>
                  <thead>
                    <tr className={HEAD}>
                      <th className={TH}>Area</th>
                      {months.map((month) => (
                        <th className={THR} key={month}>
                          {month}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleAreas.map((row) => (
                      <tr className={ROW} key={areaKey(row)}>
                        <td className={cn(TD, "font-bold")}>{row.area}</td>
                        {months.map((month, index) => (
                          <td className={cn(TDR, (row.trend[index] ?? 0) < 0 && "font-black text-rose-700")} key={month}>
                            {egp(row.trend[index] ?? 0)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              )}
            />
          </PortalSection>

          {showDms ? (
            <PortalSection
              description="Where each district is strong and weak. Family rollups sum include-eligible SKUs only, so an excluded product cannot inflate a family."
              eyebrow="Mix"
              title="Product mix by district"
            >
              <div className="grid gap-3 p-4 md:grid-cols-2">
                {visibleDms.map((row) => {
                  const dmFamilies = row.families ?? [];
                  const dmProducts = row.keyProducts ?? keyProducts;
                  // Family level only when it actually groups something — otherwise it would
                  // just relabel the product list.
                  const groupByFamily = dmFamilies.length > 1 && dmFamilies.length < dmProducts.length;
                  const mixCells = groupByFamily
                    ? dmFamilies.map((family) => ({ ach: row.familyAch?.[family] ?? null, label: family }))
                    : dmProducts.map((product) => ({ ach: row.productAch?.[product] ?? null, label: product }));
                  return (
                    <div className={cn(portalSubtlePanelClassName, "p-3.5")} key={dmKey(row)}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="whitespace-nowrap text-sm font-black text-slate-950">{row.dm}</p>
                          <p className="mt-0.5 text-xs font-semibold text-slate-500">
                            {row.line ? `${row.line} · ` : ""}
                            {groupByFamily ? "by family" : "by product"}
                          </p>
                        </div>
                        <Ach value={row.allProducts.ach} />
                      </div>
                      <dl className="mt-2.5 grid grid-cols-2 gap-2">
                        {mixCells.map((cell) => (
                          <div className={FIELD} key={cell.label}>
                            <dt className={cn(FIELD_LABEL, "whitespace-nowrap")}>{cell.label}</dt>
                            <dd className="mt-0.5">
                              <Ach value={cell.ach} />
                            </dd>
                          </div>
                        ))}
                      </dl>
                      <p className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-slate-500">
                        <span>
                          Marketing <b className="text-slate-800">{egp(row.marketingCost)}</b>
                        </span>
                        <span>
                          Outstation <b className="text-slate-800">{egp(row.outstationCost)}</b>
                        </span>
                        <span>
                          Doubles <b className="text-slate-800">{numOrNA(row.doubleVisits, visitsOf(row))}</b>
                        </span>
                      </p>
                    </div>
                  );
                })}
              </div>
            </PortalSection>
          ) : null}

          {productTables.map((table) => (
            <PortalSection eyebrow="Catalogue" key={table.id} title={`${table.label} — products`}>
              <PortalResponsiveDataList
                empty={nothing("No product row.")}
                getKey={(row) => row.product}
                items={table.products}
                renderCard={(row) => (
                  <div className="px-4 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="whitespace-nowrap text-sm font-black text-slate-950">{row.product}</h3>
                        <p className="mt-0.5 text-xs font-semibold text-slate-500">
                          {row.family}
                          {row.include ? "" : " · excluded from incentive"}
                        </p>
                      </div>
                      <Ach value={row.total.ach} />
                    </div>
                    <p className="mt-1 text-xs font-semibold text-slate-500">
                      {egp(row.total.sales)} of {egp(row.total.target)}
                    </p>
                  </div>
                )}
                renderTable={() => (
                  <PortalDesktopTable minWidth="860px">
                    <thead>
                      <tr className={HEAD}>
                        <th className={TH}>Product</th>
                        <th className={TH}>Family</th>
                        <th className={TH}>Incentive</th>
                        <th className={TH}>Achievement</th>
                        <th className={THR}>Sales</th>
                        <th className={THR}>Target</th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.products.map((row) => (
                        <tr className={ROW} key={row.product}>
                          <td className={cn(TD, "font-black")}>{row.product}</td>
                          <td className={cn(TD, "text-xs text-slate-500")}>{row.family}</td>
                          <td className={cn(TD, "text-xs text-slate-500")}>{row.include ? "Included" : "Excluded"}</td>
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
          ))}
        </div>
      ) : null}

      <p className="px-1 text-[11px] font-semibold leading-5 text-slate-400">
        Territory resolved from the live organogram seat map (snapshot {mapGeneratedAt.slice(0, 10)}). S1 figures are the
        Jan–Jun actuals for these areas and are not restated when a seat changes hands, so an area shown as vacant for S1 may
        have an occupant today.
      </p>
    </div>
  );
}
