"use client";

// Weekly Sales — a MEDICAL REP's own screen: his area, week by week, per product.
//
// Built for the owner's "in medical rep accounts show weekly sales". Four rules shape it:
//
//  1. HIS OWN AREA ONLY. The server narrows everything to the viewer's own seat before this component
//     receives it (getPortalWeeklyRepSales), so there is no other rep, region total or distributor here
//     to hide. Nothing on this screen names anyone but him.
//  2. UNITS ARE NEVER ADDED ACROSS PRODUCTS (owner rule). Totals are EGP. A unit figure only ever sits in
//     one product's row, and there is no "total units" anywhere.
//  3. AN ALLOCATION IS LABELLED AS ONE. A weekly row is a depot shipment, and most of a rep's figure is
//     spread from depot names, so the strip at the bottom states how much was mapped and how much spread.
//  4. IT FITS THE SCREEN (owner golden rule). No horizontal scroll at any width: a fixed-layout table on
//     desktop, cards on a phone, and long names wrap rather than being cut.
//
// A week that carries sales from a depot which sent no sheet for the week before also holds that missing
// week. It is marked, it gets no up/down arrow, and it can never be the "best week": a data hole must not
// read as a good week.
//
// A second tab, "Depot Detail", lays the same month out exactly as Weekly Stock (owner, 2026-09-16):
// every product at every depot, still his own area's share and nothing wider.

import { useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownRight,
  ArrowUp,
  ArrowUpRight,
  Building2,
  CalendarRange,
  Coins,
  Layers,
  MapPin,
  Package,
  RefreshCw,
  TrendingUp,
  Trophy,
} from "lucide-react";

import { formatEgp, formatEgpFull } from "@/components/sales/target-visuals";
import { WeeklySalesDepotDetail } from "@/components/sales/weekly/weekly-sales-depot-detail";
import type {
  PortalWeeklyRepSales,
  PortalWeeklyRepStatus,
  RepWeeklyWeek,
} from "@/lib/sales/weekly/portal-weekly-rep";
import { weeklyAreaLabel, weeklyRegionLabel } from "@/lib/sales/weekly/display-labels";
import { WEEKLY_UNITS_UNDER_ONE, weeklyUnitsUnderOne } from "@/lib/sales/weekly/unit-totals";
import { phxFieldClassName } from "@/components/ui/form-tokens";

type RepTab = "month" | "detail";

// ── formatting ──────────────────────────────────────────────────────────────────────────────
// Money comes from the shared sales formatters (target-visuals.tsx), so every sales screen prints it
// the same way. formatNumber stays here: the unit wrappers below are lifted from this file and run by
// tests/weekly-units-under-one.test.ts, which needs it beside them.
function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-01" → "Sep". A string parse, so the viewer's time zone cannot move the month. */
function shortMonthOf(cycleMonth: string | null | undefined): string {
  const month = /^\d{4}-(\d{2})-/.exec(cycleMonth ?? "")?.[1];
  return month ? (SHORT_MONTHS[Number(month) - 1] ?? "") : "";
}

/** A figure that rounds to nothing reads as a dash, so an empty week never looks like a measured zero. */
const isNil = (value: number) => Math.round(value) === 0;

/** A unit figure in a week cell: a share under one unit reads "<1", never the dash of an empty week. */
const unitsCell = (units: number) =>
  weeklyUnitsUnderOne(units) ? WEEKLY_UNITS_UNDER_ONE : isNil(units) ? "—" : formatNumber(units);

/** A product's unit total: a share under one unit reads "<1", never a "0" beside the money it earned. */
const unitsTotal = (units: number) => (weeklyUnitsUnderOne(units) ? WEEKLY_UNITS_UNDER_ONE : formatNumber(units));

export function PortalWeeklyRepView({ data }: { data: PortalWeeklyRepSales }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [tab, setTab] = useState<RepTab>("month");
  // Depot Detail loads on its first opening, then stays mounted so its own filters survive a tab switch.
  const [detailOpened, setDetailOpened] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  if (data.status !== "ok") return <RepWeeklyEmpty status={data.status} />;

  const { weeks, totals, products, areas } = data;
  const byWeek = totals.valueByWeek;
  const weekPeak = peakOf(weeks, byWeek);
  const monthShort = shortMonthOf(data.month?.code);
  const lastWeek = weeks[weeks.length - 1] ?? null;
  const previousWeek = weeks.length > 1 ? weeks[weeks.length - 2] : null;
  const bestWeek = weeks.reduce<RepWeeklyWeek | null>((best, week) => {
    const value = byWeek[week.weekNumber] ?? 0;
    if (week.spansGap || !(value > 0)) return best;
    return !best || value > (byWeek[best.weekNumber] ?? 0) ? week : best;
  }, null);
  const productsSold = products.filter(
    (product) => Math.round(product.units) > 0 || Math.round(product.value) > 0,
  ).length;
  const gapWeeks = weeks.filter((week) => week.spansGap).map((week) => week.weekNumber);

  const areaSummary = [...new Set(areas.map((area) => weeklyAreaLabel(area.areaName)))].join(", ");
  const placeSummary = [
    ...new Set(areas.map((area) => area.lineName)),
    ...new Set(areas.map((area) => weeklyRegionLabel(area.regionName)).filter(Boolean)),
  ].join(" · ");

  const goToMonth = (code: string) => {
    startTransition(() => {
      router.push(`${pathname}?month=${encodeURIComponent(code)}`);
    });
  };
  const syncNow = () => {
    setRefreshKey((key) => key + 1);
    startTransition(() => {
      router.refresh();
    });
  };
  const openTab = (next: RepTab) => {
    if (next === "detail") setDetailOpened(true);
    setTab(next);
  };

  return (
    <div className="space-y-5">
      {/* Scope bar: whose area this is, which month, and a way to pull the latest upload. */}
      <div className="flex flex-col gap-3 border border-slate-200 bg-white px-4 py-3 shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="h-9 w-[3px] shrink-0 bg-orange-500" />
          <div className="min-w-0">
            <p className="text-phx-sm font-black uppercase tracking-[0.18em] text-slate-400">
              {areas.length > 1 ? "Your areas" : "Your area"}
            </p>
            <p className="break-words text-sm font-black text-slate-900">{areaSummary}</p>
            {placeSummary ? (
              <p className="break-words text-phx-sm font-bold tracking-wide text-slate-400">{placeSummary}</p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            <span className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-400">Month</span>
            <select
              value={data.month?.code ?? ""}
              onChange={(event) => goToMonth(event.target.value)}
              disabled={isPending || data.months.length === 0}
              className={phxFieldClassName}
            >
              {data.months.map((month) => (
                <option key={month.code} value={month.code}>
                  {month.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={syncNow}
            disabled={isPending}
            className="inline-flex min-h-10 items-center gap-1.5 border border-slate-200 bg-white px-2.5 py-1.5 text-phx-sm font-black uppercase tracking-wide text-slate-700 transition hover:border-orange-300 hover:text-orange-600 disabled:opacity-50 md:min-h-0"
          >
            <RefreshCw className={`h-3 w-3 ${isPending ? "animate-spin" : ""}`} />
            Sync now
          </button>
          {isPending ? (
            <span className="flex items-center gap-1.5 text-phx-sm font-bold uppercase tracking-wide text-orange-600">
              <span className="h-1.5 w-1.5 animate-pulse bg-orange-500" />
              Updating
            </span>
          ) : null}
        </div>
      </div>

      <RepTabBar active={tab} onChange={openTab} />

      {tab === "month" ? (
        <>
          {/* KPI strip — the four questions a rep asks about his own month. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <RepTile
              accent="#F97316"
              icon={Coins}
              label="Month total"
              value={formatEgp(totals.value)}
              sub={`${weeks.length} ${weeks.length === 1 ? "week" : "weeks"} uploaded`}
            />
            <RepTile
              accent="#0EA5E9"
              icon={TrendingUp}
              label="Latest week"
              value={lastWeek ? formatEgp(byWeek[lastWeek.weekNumber] ?? 0) : "—"}
              sub={latestWeekNote(lastWeek, previousWeek)}
              delta={latestWeekDelta(lastWeek, previousWeek, byWeek)}
            />
            <RepTile
              accent="#22C55E"
              icon={Trophy}
              label="Best week"
              value={bestWeek ? `Week ${bestWeek.weekNumber}` : "—"}
              sub={bestWeek ? formatEgp(byWeek[bestWeek.weekNumber] ?? 0) : "no complete week with sales yet"}
            />
            <RepTile
              accent="#8B5CF6"
              icon={Package}
              label="Products sold"
              value={formatNumber(productsSold)}
              sub="units per product below"
            />
          </div>

          {gapWeeks.length > 0 ? (
            <Notice>
              {`${gapWeeks.length === 1 ? "Week" : "Weeks"} ${gapWeeks.join(", ")} ${
                gapWeeks.length === 1 ? "carries" : "carry"
              } sales from a branch that sent no sheet for the week before, so the figure also holds the week(s) it skipped and reads high. It is marked with a dotted amber line and is never counted as your best week.`}
            </Notice>
          ) : null}

          {data.allocationUnavailable ? (
            <Notice>
              The branch-to-area map did not load just now, so only branches mapped to your area by hand are counted and
              your figure reads low. Press Sync now in a moment.
            </Notice>
          ) : null}

          {/* Week by week, in EGP — money adds across products, so a week total is legitimate. */}
          <RepSection title="Your sales · week by week">
            {weeks.length === 0 ? (
              <p className="py-4 text-center text-xs font-semibold text-slate-400">
                {`No weekly sheet has been uploaded for ${data.month?.name ?? "this month"} yet.`}
              </p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2">
                {weeks.map((week, index) => {
                  const value = byWeek[week.weekNumber] ?? 0;
                  const previous = index === 0 ? null : (byWeek[weeks[index - 1].weekNumber] ?? 0);
                  const rank = rankWeek(value, weekPeak);
                  return (
                    <div
                      key={week.weekNumber}
                      className={`border px-3 py-2.5 ${
                        week.spansGap ? "border-amber-200 bg-amber-50/60" : "border-slate-200 bg-slate-50/60"
                      }`}
                    >
                      <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">
                        {`Week ${week.weekNumber}${monthShort ? ` · ${monthShort}` : ""}`}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-1">
                        <DirectionArrow direction={weekDirection(value, previous, week.spansGap)} />
                        <span
                          className={`text-sm tabular-nums sm:text-base ${rank.text} ${weekMark(rank, week.spansGap)}`}
                        >
                          {isNil(value) ? "—" : formatEgp(value)}
                        </span>
                      </div>
                      {week.spansGap ? (
                        <p className="mt-1 text-phx-sm font-semibold text-amber-700">includes a missing upload</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}

            {areas.length > 1 ? (
              <div className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
                {areas.map((area) => (
                  <div key={area.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <MapPin className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                      <span className="break-words text-xs font-black text-slate-800">{weeklyAreaLabel(area.areaName)}</span>
                      <span className="break-words text-phx-sm font-bold tracking-wide text-slate-400">
                        {[area.lineName, weeklyRegionLabel(area.regionName)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="text-xs font-black tabular-nums text-slate-900">{formatEgp(area.value)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </RepSection>

          {/* Per product, in UNITS — one product per row, the only level at which a unit count means anything. */}
          <RepSection title="Units per product · week by week">
            {products.length === 0 ? (
              <p className="py-4 text-center text-xs font-semibold text-slate-400">
                {`No product sales reached your area in ${data.month?.name ?? "this month"} yet.`}
              </p>
            ) : (
              <>
                <ProductTable products={products} weeks={weeks} />
                <ProductCards products={products} weeks={weeks} />
              </>
            )}
            <p className="mt-3 border-t border-slate-100 pt-2.5 text-phx-sm font-semibold leading-relaxed text-slate-400">
              Units are shown per product only. Units of different products are never added together.
            </p>
          </RepSection>

          <AttributionStrip exactValue={totals.exactValue} allocatedValue={totals.allocatedValue} />
        </>
      ) : null}

      {/* Outside the tab switch above so it stays mounted once opened (see detailOpened). */}
      {detailOpened ? (
        <WeeklySalesDepotDetail
          audience="rep"
          feedPath="/api/employee-portals/weekly-sales/rep-depot-detail"
          exportPath="/api/employee-portals/weekly-sales/rep-depot-detail/export"
          hostQuery={data.month ? new URLSearchParams({ month: data.month.code }).toString() : ""}
          refreshKey={refreshKey}
          active={tab === "detail"}
        />
      ) : null}
    </div>
  );
}

/**
 * The rep's two views of his month, in the managers' tab bar's exact look. Two tabs side by side at
 * every width: stacked on a phone they cost two full-width rows before any figure, and the hint under
 * each label only shows from `sm` up.
 */
function RepTabBar({ active, onChange }: { active: RepTab; onChange: (next: RepTab) => void }) {
  const tabs: { key: RepTab; label: string; hint: string; icon: typeof Coins }[] = [
    { key: "month", label: "My Month", hint: "Week by week, per product", icon: CalendarRange },
    { key: "detail", label: "Branch Detail", hint: "Every product at every branch", icon: Building2 },
  ];
  return (
    <div className="overflow-hidden border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60">
      <div className="grid grid-cols-2">
        {tabs.map((item) => {
          const isActive = active === item.key;
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onChange(item.key)}
              aria-current={isActive ? "page" : undefined}
              className={`relative flex min-w-0 items-center gap-2 px-3 py-3 text-left transition sm:gap-3 sm:px-4 ${
                isActive ? "bg-slate-900" : "bg-white hover:bg-slate-50"
              }`}
            >
              <span
                className={`absolute inset-x-0 bottom-0 h-0.5 transition-all ${isActive ? "bg-orange-500" : "bg-transparent"}`}
              />
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center ${
                  isActive ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-400"
                }`}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className={`block break-words text-sm font-black tracking-tight ${isActive ? "text-white" : "text-slate-900"}`}>
                  {item.label}
                </span>
                <span className="hidden break-words text-phx-sm font-bold uppercase tracking-wide text-slate-400 sm:block">{item.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── the product grid: a fixed table on desktop, cards on a phone ─────────────────────────────

type ProductRow = PortalWeeklyRepSales["products"][number];

function ProductTable({ products, weeks }: { products: ProductRow[]; weeks: RepWeeklyWeek[] }) {
  // Fixed layout with every width declared, so the table can never grow past its container. The weeks
  // share what the product name, units and value columns leave; a long product name wraps instead.
  // It opens at `md`, like every other sales table: a tablet's ~736px column is wider than the ~620px
  // this table was fitted to at 1024px with the sidebar open, so a tablet reads the table, not cards.
  const weekWidth = weeks.length > 0 ? 52 / weeks.length : 0;
  const peaks = new Map(products.map((product) => [product.productCode, peakOf(weeks, product.unitsByWeek)]));
  return (
    <div className="hidden md:block">
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col style={{ width: weeks.length > 0 ? "24%" : "76%" }} />
          {weeks.map((week) => (
            <col key={week.weekNumber} style={{ width: `${weekWidth}%` }} />
          ))}
          <col style={{ width: "10%" }} />
          <col style={{ width: "14%" }} />
        </colgroup>
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            <th className="px-3 py-2 text-left text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">
              Product
            </th>
            {weeks.map((week) => (
              <th
                key={week.weekNumber}
                className="px-1.5 py-2 text-right text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500"
                title={week.spansGap ? "Also holds a week a branch never uploaded" : undefined}
              >
                {`W${week.weekNumber}`}
                {week.spansGap ? <span className="ml-0.5 text-amber-500">•</span> : null}
              </th>
            ))}
            <th className="px-2 py-2 text-right text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">
              Units
            </th>
            <th className="px-2 py-2 text-right text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">
              Value
            </th>
          </tr>
        </thead>
        <tbody>
          {products.map((product) => {
            const peak = peaks.get(product.productCode) ?? 0;
            return (
              <tr key={product.productCode} className="border-b border-slate-100 last:border-0">
                <td className="break-words px-3 py-2 text-xs font-bold text-slate-800">{product.productName}</td>
                {weeks.map((week, index) => {
                  const units = product.unitsByWeek[week.weekNumber] ?? 0;
                  const previous = index === 0 ? null : (product.unitsByWeek[weeks[index - 1].weekNumber] ?? 0);
                  const rank = rankWeek(units, peak);
                  return (
                    <td key={week.weekNumber} className="px-1.5 py-2 text-right text-xs">
                      <span className="inline-flex flex-wrap items-center justify-end gap-x-0.5">
                        <DirectionArrow direction={weekDirection(units, previous, week.spansGap)} />
                        <span className={`tabular-nums ${rank.text} ${weekMark(rank, week.spansGap)}`}>
                          {unitsCell(units)}
                        </span>
                      </span>
                    </td>
                  );
                })}
                <td className="px-2 py-2 text-right text-xs font-black tabular-nums text-slate-900">
                  {unitsTotal(product.units)}
                </td>
                {/* px-2, not px-3: at 1024px (the narrowest desktop, sidebar open) px-3 broke "EGP 81.2K" onto two lines. */}
                <td className="px-2 py-2 text-right text-xs font-bold tabular-nums text-slate-500">
                  {formatEgp(product.value)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProductCards({ products, weeks }: { products: ProductRow[]; weeks: RepWeeklyWeek[] }) {
  return (
    <div className="divide-y divide-slate-100 md:hidden">
      {products.map((product) => {
        const peak = peakOf(weeks, product.unitsByWeek);
        return (
          <div key={product.productCode} className="py-3 first:pt-0">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 flex-1 break-words text-sm font-black text-slate-900">{product.productName}</p>
              <div className="text-right">
                <p className="whitespace-nowrap text-sm font-black tabular-nums text-slate-900">
                  {`${unitsTotal(product.units)} units`}
                </p>
                <p className="whitespace-nowrap text-phx-sm font-bold tabular-nums text-slate-400">
                  {formatEgp(product.value)}
                </p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {weeks.map((week, index) => {
                const units = product.unitsByWeek[week.weekNumber] ?? 0;
                const previous = index === 0 ? null : (product.unitsByWeek[weeks[index - 1].weekNumber] ?? 0);
                const rank = rankWeek(units, peak);
                return (
                  <span
                    key={week.weekNumber}
                    className={`inline-flex items-center gap-1 whitespace-nowrap border px-1.5 py-0.5 text-phx-sm tabular-nums ${
                      week.spansGap
                        ? "border-dotted border-amber-400 bg-amber-50"
                        : rank.peak
                          ? "border-orange-300 bg-orange-50"
                          : "border-slate-200 bg-slate-50"
                    } ${rank.text}`}
                  >
                    <span className="text-slate-400">{`W${week.weekNumber}`}</span>
                    <DirectionArrow direction={weekDirection(units, previous, week.spansGap)} />
                    {unitsCell(units)}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── supporting pieces ────────────────────────────────────────────────────────────────────────

type WeekRank = { text: string; peak: boolean };

/**
 * Rank one week against the best complete week of its OWN row, in ink rather than fill (the managers'
 * tab does the same): the weight of the type carries it, and a hairline marks the single best week.
 */
function rankWeek(value: number, peak: number): WeekRank {
  if (!(value > 0) || !(peak > 0)) return { text: "font-medium text-slate-400", peak: false };
  const share = value / peak;
  if (share >= 0.999) return { text: "font-black text-slate-900", peak: true };
  if (share >= 0.5) return { text: "font-bold text-slate-700", peak: false };
  return { text: "font-semibold text-slate-500", peak: false };
}

/** The underline under a week figure. A gap week's dotted amber line wins over the peak hairline. */
function weekMark(rank: WeekRank, spansGap: boolean): string {
  if (spansGap) return "border-b-2 border-dotted border-amber-400 pb-0.5";
  return rank.peak ? "border-b-2 border-orange-400 pb-0.5" : "";
}

/** The best COMPLETE week: a gap week carries two weeks of sales and would dwarf every honest week. */
function peakOf(weeks: RepWeeklyWeek[], byWeek: Record<number, number>): number {
  return weeks.reduce((max, week) => (week.spansGap ? max : Math.max(max, byWeek[week.weekNumber] ?? 0)), 0);
}

/**
 * Up or down on the week before. Blind on the first week (nothing to compare) and on a gap week, whose
 * figure includes an upload that never happened — an arrow there would read a data hole as a success.
 */
function weekDirection(value: number, previous: number | null, gap: boolean): "up" | "down" | null {
  if (gap || previous === null) return null;
  if (Math.round(value) > Math.round(previous)) return "up";
  if (Math.round(value) < Math.round(previous)) return "down";
  return null;
}

function DirectionArrow({ direction }: { direction: "up" | "down" | null }) {
  if (direction === "up") return <ArrowUp className="h-2.5 w-2.5 shrink-0 text-emerald-500" strokeWidth={4} />;
  if (direction === "down") return <ArrowDown className="h-2.5 w-2.5 shrink-0 text-rose-400" strokeWidth={4} />;
  return null;
}

function latestWeekNote(last: RepWeeklyWeek | null, previous: RepWeeklyWeek | null): string {
  if (!last) return "no week uploaded yet";
  if (last.spansGap) return `Week ${last.weekNumber} · includes a missing upload`;
  if (!previous) return `Week ${last.weekNumber} · the first this month`;
  return `Week ${last.weekNumber} · against week ${previous.weekNumber}`;
}

/** Change on the week before, or nothing when either side cannot carry a fair comparison. */
function latestWeekDelta(
  last: RepWeeklyWeek | null,
  previous: RepWeeklyWeek | null,
  byWeek: Record<number, number>,
): number | null {
  if (!last || !previous || last.spansGap) return null;
  const before = byWeek[previous.weekNumber] ?? 0;
  if (!(before > 0)) return null;
  return ((byWeek[last.weekNumber] ?? 0) - before) / before;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 border border-amber-200 bg-amber-50 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <p className="text-xs font-semibold leading-relaxed text-amber-900">{children}</p>
    </div>
  );
}

function RepSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-3.5 w-[3px] shrink-0 bg-orange-500" />
          <h2 className="text-phx-sm font-black uppercase tracking-[0.18em] text-slate-200">{title}</h2>
        </div>
        <span className="h-1.5 w-10 shrink-0 bg-orange-500/80" />
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function RepTile({
  accent,
  icon: Icon,
  label,
  value,
  sub,
  delta,
}: {
  accent: string;
  icon: typeof Coins;
  label: string;
  value: string;
  sub?: string;
  delta?: number | null;
}) {
  return (
    <div className="group relative overflow-hidden border border-slate-200 bg-white shadow-[0_8px_22px_rgba(15,23,42,0.04)] ring-1 ring-slate-200/60 transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_34px_rgba(15,23,42,0.08)]">
      <span
        className="absolute inset-x-0 top-0 h-1 transition-all duration-200 group-hover:h-1.5"
        style={{ backgroundColor: accent }}
      />
      <div className="p-3.5 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <span
            className="flex h-7 w-7 items-center justify-center"
            style={{ backgroundColor: `${accent}1A`, color: accent }}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          {delta != null ? <DeltaPill delta={delta} /> : null}
        </div>
        <p className="mt-2.5 text-phx-sm font-black uppercase tracking-[0.12em] text-slate-400">{label}</p>
        <p className="mt-0.5 break-words text-lg font-black tabular-nums tracking-tight text-slate-900 sm:text-xl">
          {value}
        </p>
        {sub ? <p className="mt-0.5 text-phx-sm font-semibold leading-snug text-slate-400">{sub}</p> : null}
      </div>
    </div>
  );
}

function DeltaPill({ delta }: { delta: number }) {
  const up = delta >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-phx-sm font-black tabular-nums ${
        up ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
      }`}
    >
      <Icon className="h-3 w-3" />
      {`${up ? "+" : ""}${(delta * 100).toFixed(1)}%`}
    </span>
  );
}

/**
 * How much of his figure was mapped and how much was spread. Not decoration: a weekly row is a depot
 * shipment, and a rep must be able to see that his number is mostly an allocation before he acts on it.
 */
function AttributionStrip({ exactValue, allocatedValue }: { exactValue: number; allocatedValue: number }) {
  const total = exactValue + allocatedValue;
  const safe = total > 0 ? total : 1;
  const parts = [
    { label: "Mapped by hand", value: exactValue, fill: "bg-emerald-500", tone: "text-emerald-700" },
    { label: "Allocated from branch name", value: allocatedValue, fill: "bg-amber-400", tone: "text-amber-700" },
  ];
  const showBar = total > 0 && exactValue >= 0 && allocatedValue >= 0;
  return (
    <RepSection title="How your figure was worked out">
      <div className="space-y-3">
        {showBar ? (
          <div className="flex h-2 w-full overflow-hidden bg-slate-100">
            {parts.map((part) => (
              <div
                key={part.label}
                className={part.fill}
                style={{ width: `${(part.value / safe) * 100}%` }}
                title={`${part.label}: ${formatEgpFull(part.value)}`}
              />
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {parts.map((part) => (
            <div key={part.label} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className={`h-2 w-2 shrink-0 ${part.fill}`} />
              <span className="text-phx-sm font-black uppercase tracking-wide text-slate-500">{part.label}</span>
              <span className={`whitespace-nowrap text-xs font-black tabular-nums ${part.tone}`}>
                {formatEgp(part.value)}
              </span>
              {total > 0 ? (
                <span className="whitespace-nowrap text-phx-sm font-bold tabular-nums text-slate-400">
                  {formatPct(part.value / safe)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
        <p className="text-xs font-semibold leading-relaxed text-slate-500">
          Weekly sales arrive at distributor-branch level, not per customer. A branch mapped to your area by hand
          credits you exactly. Any other branch has its money spread evenly across the governorates its name
          states, then evenly again across that governorate&rsquo;s areas on your line &mdash; so this figure is an
          allocation of branch shipments, not a record of visits or of sales observed in your territory. Products
          with no product-master mapping are left out. The Monthly Closing remains the official number.
        </p>
      </div>
    </RepSection>
  );
}

const EMPTY_COPY: Record<Exclude<PortalWeeklyRepStatus, "ok">, { title: string; message: string }> = {
  no_access: {
    title: "Your weekly sales scope is not set",
    message:
      "Your account has no sales line on record, so no weekly figures can be shown. Ask HR to confirm the line on your employee record.",
  },
  seat_index_unavailable: {
    title: "The organogram could not be read",
    message: "Your area comes from the organogram, which did not answer just now. Reload the page in a moment.",
  },
  no_seat: {
    title: "No area is assigned to you yet",
    message:
      "Weekly sales reach a rep through their seat in the organogram, and no filled rep seat lists you on your line. If you have just joined or moved, the organogram may not be updated yet.",
  },
  no_data: {
    title: "No weekly sheet uploaded yet",
    message: "No distributor sheet has been validated yet. Your weekly sales appear here once the first one is.",
  },
};

function RepWeeklyEmpty({ status }: { status: Exclude<PortalWeeklyRepStatus, "ok"> }) {
  const copy = EMPTY_COPY[status];
  return (
    <div className="border border-slate-200 bg-white p-10 text-center shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60">
      <span className="mx-auto flex h-11 w-11 items-center justify-center bg-orange-50 text-orange-500">
        <Layers className="h-5 w-5" />
      </span>
      <p className="mt-3 text-sm font-black text-slate-900">{copy.title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-xs font-semibold leading-relaxed text-slate-500">{copy.message}</p>
    </div>
  );
}
