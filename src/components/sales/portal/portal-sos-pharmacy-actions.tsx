"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Ban, Download, Gauge, Store, TrendingDown, UserPlus } from "lucide-react";

import {
  BandChoice,
  BandStat,
  CommandBand,
  SectionCard,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
  chipClass,
  formatEgp,
  formatPeriod,
} from "@/components/sales/target-visuals";
import type { MonthPaceResult, MonthPaceRow } from "@/lib/sales/sos-month-pace";
import type { PortalPharmacyActionsPayload } from "@/lib/sales/sos-pharmacy-actions-loader";
import {
  LOOKBACK_CLOSINGS,
  MAX_LOOKBACK_CLOSINGS,
  type BrickUniverseEntry,
  type CrossSellItem,
  type PharmacyActionItem,
  type PharmacyAreaSummary,
} from "@/lib/sales/sos-pharmacy-actions";
import {
  brickOptionsOf,
  filterBricks,
  filterPharmacyItems,
  hasListFilter,
  readChannel,
  type PharmacyListFilter,
} from "@/lib/sales/sos-pharmacy-actions-filter";
import { closingIntro, earlierClosings, paceWords, wholePercentText } from "@/lib/sales/sos-portal-words";
import { phxButtonGhostClassName, phxFieldClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { landingActionClassName } from "@/components/employee-portal/landing-kit";

// "Where my sales come from" — the pharmacy action lists and the weekly month pace, above the
// distributor dashboard. Every rule is computed server-side (sos-pharmacy-actions.ts); this file
// only renders. Names only, never codes; value only, never units; square edges; no horizontal scroll
// (fixed tables with a colgroup on desktop, cards on mobile).
//
// The look is the shared light sales language (target-visuals.tsx): the page opens with the same
// CommandBand as Sales vs Target, Targets and Make It Happen. The band carries CLOSING figures only —
// the weekly month pace stays in its own section, labelled "weekly, approximate", and is never put
// beside the closing numbers in the header.
//
// classNames here are plain strings, never cn(): tailwind-merge treats the custom `text-phx-*`
// sizes as colours and silently drops one of the pair.

type ApiResponse = {
  success: boolean;
  data?: PortalPharmacyActionsPayload;
  pace?: MonthPaceResult | null;
  error?: string;
};

type TabKey = "stopped" | "dropping" | "newPharmacies" | "top" | "crossSell" | "untappedBricks";

const TABS: { key: TabKey; label: string; hint: (earlier: number) => string }[] = [
  {
    key: "stopped",
    label: "Stopped buying",
    hint: (earlier) =>
      `Bought in ${earlier === 1 ? "" : "at least one of "}${earlierClosings(earlier)}, and nothing in the latest. Biggest monthly average first.`,
  },
  {
    key: "dropping",
    label: "Dropping",
    hint: (earlier) => `The latest closing is 30% or more below its average over ${earlierClosings(earlier)}. Biggest gap first.`,
  },
  { key: "newPharmacies", label: "New", hint: (earlier) => `Bought in the latest closing and in none of ${earlierClosings(earlier)}.` },
  { key: "top", label: "Top pharmacies", hint: () => "Your biggest pharmacies in the latest closing and their share of your pharmacy sales." },
  {
    key: "crossSell",
    label: "Cross-sell gaps",
    hint: () => "Buys some of the products most of your pharmacies buy, but not these — across every closing shown.",
  },
  {
    key: "untappedBricks",
    label: "Untapped bricks",
    hint: () => "Bricks in your areas where no pharmacy bought anything across every closing shown.",
  },
];

const PAGE_SIZE = 10;

/** An area the picker offers (from the weekly pace) with nothing in the closing: every figure is zero. */
const EMPTY_AREA: PharmacyAreaSummary = {
  counts: { activePharmacies: 0, stopped: 0, dropping: 0, newPharmacies: 0, crossSell: 0, untappedBricks: 0 },
  valueAtStake: { stopped: 0, dropping: 0, newPharmacies: 0 },
  latestTotals: { total: 0, pharmacies: 0, mainStores: 0, wholesalerShares: 0, noCustomerCode: 0 },
  stopped: [],
  dropping: [],
  newPharmacies: [],
  top: [],
  crossSell: [],
  untappedBricks: [],
};

const BAND_KICKER = "Sales Operations";
const BAND_TITLE = "Source of Sales";

// Money and months come from the shared sales formatters (target-visuals.tsx), so this page prints
// them exactly as Sales vs Target and Targets do. The percentage stays whole, and it is cut toward
// zero (sos-portal-words.ts): 99.6% of target never reads "100%", a 29.6% drop never reads "30%".
const formatPct = wholePercentText;

// A phone tap target is at least 40px; the compact 32px control returns from `md` up.
const SELECT_CLASS = cn(phxSelectClassName, "min-w-0 max-w-full px-2 text-xs hover:border-[#08111f] md:h-8");
const SEARCH_CLASS = cn(phxFieldClassName, "min-w-0 w-full px-2 text-xs md:h-8");
const FILTER_LABEL = "mb-1 block whitespace-nowrap text-phx-xs font-black uppercase tracking-[0.18em] text-slate-500";
/** The shared chip, grown to a 40px tap target on a phone. Appended as a plain string, never cn(). */
const TAP_CHIP = "min-h-10 md:min-h-0";

function Tile({
  accent,
  icon: Icon,
  label,
  value,
  sub,
  active,
  onClick,
}: {
  accent: string;
  icon: typeof Ban;
  label: string;
  value: string;
  sub: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      // Not SURFACE_CLASS: its border and background colours would sit beside the active ones
      // in one class list, and which of two same-kind utilities wins is not decided by order.
      className={`relative border text-left ${adminSoftDepthClassName} transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#08111f] ${
        active ? "border-[#08111f] bg-white ring-2 ring-inset ring-[#08111f]" : "border-slate-200 bg-white hover:border-[#08111f]"
      }`}
      onClick={onClick}
      type="button"
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{ backgroundColor: accent }} />
      <div className="p-3.5 pt-4 sm:p-4 sm:pt-5">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">{label}</p>
          <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" style={{ color: accent }} />
        </div>
        <p className="mt-1 text-3xl font-black tabular-nums leading-none tracking-tight text-slate-900">{value}</p>
        <p className="mt-2 text-phx-xs font-semibold text-slate-500">{sub}</p>
      </div>
    </button>
  );
}

function PharmacyName({ item }: { item: PharmacyActionItem }) {
  const place = [item.brickName, item.areaName].filter(Boolean).join(" · ");
  return (
    <div className="min-w-0">
      <p className="break-words text-sm font-bold text-slate-900">
        {item.name}
        {item.isDirect ? (
          <span className="ml-2 inline-block border-l-2 border-[#08111f] pl-1.5 align-middle text-phx-xs font-black uppercase leading-tight tracking-[0.06em] text-[#08111f]">
            Direct order
          </span>
        ) : null}
      </p>
      {place ? <p className="mt-0.5 break-words text-phx-xs font-semibold text-slate-500">{place}</p> : null}
      {item.address ? <p className="break-words text-phx-xs text-slate-400">{item.address}</p> : null}
    </div>
  );
}

function ChangePill({ change }: { change: number | null }) {
  if (change == null) return <span className="text-slate-400">—</span>;
  const down = change < 0;
  return (
    <span
      className={`inline-flex text-phx-xs font-black tabular-nums ${down ? "text-rose-700" : "text-emerald-700"}`}
    >
      {`${down ? "" : "+"}${formatPct(change)}`}
    </span>
  );
}

type Column<T> = { label: string; width: string; align?: "right"; render: (item: T) => ReactNode };

function ResponsiveTable<T extends { key: string }>({
  items,
  columns,
  lead,
  emptyText,
}: {
  items: T[];
  columns: Column<T>[];
  /** The first column, also the card heading on mobile. */
  lead: Column<T>;
  emptyText: string;
}) {
  if (items.length === 0) {
    return (
      <p className="border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center text-sm font-semibold text-slate-500">{emptyText}</p>
    );
  }
  return (
    <>
      <div className="hidden border border-slate-200 md:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col style={{ width: lead.width }} />
            {columns.map((column) => (
              <col key={column.label} style={{ width: column.width }} />
            ))}
          </colgroup>
          <thead>
            <tr className={TABLE_HEAD_CLASS}>
              <th className="px-3 py-2.5 text-left">{lead.label}</th>
              {columns.map((column) => (
                <th key={column.label} className={`px-3 py-2.5 ${column.align === "right" ? "text-right" : "text-left"}`}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key} className={`${TABLE_ROW_CLASS} align-top`}>
                <td className="px-3 py-3">{lead.render(item)}</td>
                {columns.map((column) => (
                  <td
                    key={column.label}
                    className={`px-3 py-3 font-semibold tabular-nums text-slate-800 ${column.align === "right" ? "text-right" : "text-left"}`}
                  >
                    {column.render(item)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 md:hidden">
        {items.map((item) => (
          <div key={item.key} className="border border-l-[3px] border-slate-200 border-l-[#08111f] bg-white p-3">
            {lead.render(item)}
            <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-slate-100 pt-2.5">
              {columns.map((column) => (
                <div key={column.label} className="min-w-0">
                  <dt className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">{column.label}</dt>
                  <dd className="break-words text-sm font-bold tabular-nums text-slate-900">{column.render(item)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}

const count = (value: number): string => value.toLocaleString("en-US");

/**
 * `total` is the length of the list the server sent, which is capped (ACTION_LIST_LIMIT); `full` is the
 * uncapped count the tile and the tab chip show. When they differ the list says so in words, so a tile
 * reading 1,362 beside a list that ends at 200 is never left to be discovered.
 */
function ShowMore({ shown, total, full, onMore }: { shown: number; total: number; full: number; onMore: () => void }) {
  const truncated = full > total;
  if (shown >= total && !truncated) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-phx-xs font-semibold text-slate-500">
        {shown >= total
          ? `Showing the first ${count(total)} of ${count(full)} — the list stops here; narrow it by area to see the rest.`
          : truncated
            ? `Showing ${count(shown)} of the first ${count(total)} (of ${count(full)} in all)`
            : `Showing ${count(shown)} of ${count(total)}`}
      </p>
      {shown < total ? (
        <button className={`${chipClass(false, "portal")} ${TAP_CHIP}`} onClick={onMore} type="button">
          Show more
        </button>
      ) : null}
    </div>
  );
}

const pharmacyLead: Column<PharmacyActionItem> = { label: "Pharmacy", width: "46%", render: (item) => <PharmacyName item={item} /> };

function PaceBar({ row }: { row: MonthPaceRow }) {
  if (row.progress == null) return <span className="text-phx-xs font-semibold text-slate-400">No target</span>;
  const words = paceWords(row);
  const width = Math.min(100, Math.max(0, row.progress * 100));
  const expected = row.targetValue ? Math.min(100, ((row.expectedByToday ?? 0) / row.targetValue) * 100) : 0;
  return (
    <div className="min-w-0 pt-1">
      <div className="relative h-2.5 w-full bg-slate-100">
        <span className={`absolute inset-y-0 left-0 ${row.onPace ? "bg-emerald-500" : "bg-amber-500"}`} style={{ width: `${width}%` }} />
        <span aria-hidden className="absolute -bottom-1 -top-1 w-0.5 -translate-x-1/2 bg-slate-900" style={{ left: `${expected}%` }} />
      </div>
      {/* The mark's meaning is printed, not a hover title: a phone has no hover. */}
      <p className="mt-1.5 break-words text-phx-xs font-bold tabular-nums text-slate-600">{words.progressText}</p>
      {words.expectedText ? <p className="break-words text-phx-xs font-semibold tabular-nums text-slate-500">{words.expectedText}</p> : null}
    </div>
  );
}

function ExpectedLegend() {
  return (
    <span className="inline-flex items-center gap-1.5 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
      <span aria-hidden className="h-3.5 w-0.5 bg-slate-900" />
      Expected by today
    </span>
  );
}

function MonthPace({ pace, area }: { pace: MonthPaceResult; area: string }) {
  const rows = area ? pace.rows.filter((row) => row.areaCode === area) : pace.rows;
  const month = formatPeriod(pace.period);
  const showDirect = pace.hasDirectOrders;
  // Four columns at every width (fits-the-screen rule): the target, the weekly figure and the direct
  // orders are MERGED into one "so far of target" cell rather than three money columns, which at
  // 1024px with the sidebar open left each figure about 60px and broke every one onto two lines.
  const leadColumn: Column<MonthPaceRow & { key: string }> = {
    label: "Area",
    width: "24%",
    render: (row) => <span className="break-words text-sm font-bold text-slate-900">{row.areaName}</span>,
  };
  const columns: Column<MonthPaceRow & { key: string }>[] = [
    {
      label: "So far of target",
      width: "34%",
      align: "right",
      render: (row) => (
        <div className="min-w-0">
          <p className="break-words">
            {row.targetValue == null ? formatEgp(row.soFarValue) : `${formatEgp(row.soFarValue)} of ${formatEgp(row.targetValue)}`}
          </p>
          {showDirect ? (
            <p className="mt-0.5 break-words text-phx-xs font-semibold text-slate-500">
              {`weekly ${formatEgp(row.weeklyValue)} + direct ${formatEgp(row.directValue)}`}
            </p>
          ) : null}
        </div>
      ),
    },
    { label: "Progress", width: "28%", render: (row) => <PaceBar row={row} /> },
    {
      label: "Pace",
      width: "14%",
      render: (row) => {
        const words = paceWords(row);
        if (words.badge == null) return <span className="text-slate-400">—</span>;
        return (
          <div className="min-w-0">
            <span
              className={`inline-block border-l-2 pl-1.5 text-phx-xs font-black uppercase leading-tight tracking-[0.06em] ${
                row.onPace ? "border-emerald-500 text-emerald-700" : "border-amber-500 text-amber-700"
              }`}
            >
              {words.badge}
            </span>
            {words.shortBy != null ? (
              <p className="mt-1 break-words text-phx-xs font-semibold tabular-nums text-amber-700">{`${formatEgp(words.shortBy)} short of today's mark`}</p>
            ) : null}
          </div>
        );
      },
    },
  ];
  return (
    <SectionCard actions={rows.length > 0 && pace.hasTargets ? <ExpectedLegend /> : undefined} icon={Gauge} title={`Month pace · ${month} · weekly, approximate`}>
      <div className="p-4">
        <p className="mb-4 text-sm leading-6 text-slate-600">
          {`Weekly depot uploads so far in ${month}, plus the direct orders booked into ${month}, against the month's target, with the line marking where you should be by day ${pace.dayOfMonth} of ${pace.daysInMonth}. This is not the closing — the ${month} closing is the official number once it is published.`}
          {pace.allocatedShare != null && pace.allocatedShare > 0
            ? ` ${formatPct(pace.allocatedShare)} of the weekly value was placed in areas by branch name, so treat it as a guide.`
            : ""}
          {pace.directInWeekly ? ` The ${month} weekly upload already carries direct orders, so they are not added a second time.` : ""}
        </p>
        {!pace.hasWeeklyData && !pace.hasDirectOrders ? (
          <p className="mb-3 border border-dashed border-slate-200 bg-slate-50/60 p-3 text-sm font-semibold text-slate-500">{`No weekly upload for ${month} has reached your areas yet.`}</p>
        ) : null}
        {!pace.hasTargets ? (
          <p className="mb-3 border border-dashed border-slate-200 bg-slate-50/60 p-3 text-sm font-semibold text-slate-500">{`No target is loaded for ${month} yet.`}</p>
        ) : null}
        {rows.length > 0 ? (
          <ResponsiveTable
            columns={columns}
            emptyText="Nothing to show for this area."
            items={rows.map((row) => ({ ...row, key: row.areaCode }))}
            lead={leadColumn}
          />
        ) : null}
        {!area && pace.rows.length > 1 && pace.hasTargets ? (
          <p className="mt-4 border-t border-slate-100 pt-3 text-sm font-bold text-slate-700">
            {`All your areas: ${formatEgp(pace.totals.soFarValue)} of ${formatEgp(pace.totals.targetValue)}`}
            {pace.hasDirectOrders ? ` (weekly ${formatEgp(pace.totals.weeklyValue)} + direct orders ${formatEgp(pace.totals.directValue)})` : ""}
            {pace.totals.progress != null ? ` (${formatPct(pace.totals.progress)})` : ""}
            {` · expected by today ${formatEgp(pace.totals.expectedByToday)}`}
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}

function LoadingState({ subtitle }: { subtitle: string }) {
  return (
    <div className="space-y-6">
      <CommandBand surface="portal" kicker={BAND_KICKER} subtitle={subtitle} title={BAND_TITLE} />
      <SectionCard icon={Store} title="Where my sales come from">
        <div className="p-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-28 animate-pulse border border-slate-100 bg-slate-100/80" />
            ))}
          </div>
          <div className="mt-5 flex flex-wrap gap-1.5">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-7 w-24 animate-pulse bg-slate-100" />
            ))}
          </div>
          <div className="mt-4 space-y-2">
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="h-10 animate-pulse bg-slate-100" />
            ))}
          </div>
          <p className="mt-3 text-phx-xs font-semibold text-slate-500">Reading your published closings…</p>
        </div>
      </SectionCard>
    </div>
  );
}

/** One area's (or the whole) summary narrowed by the advanced filters: lists filtered, counts and money summed from them. */
function narrowScope(base: PharmacyAreaSummary, filter: PharmacyListFilter): PharmacyAreaSummary {
  const stopped = filterPharmacyItems(base.stopped, filter);
  const dropping = filterPharmacyItems(base.dropping, filter);
  const newPharmacies = filterPharmacyItems(base.newPharmacies, filter);
  const top = filterPharmacyItems(base.top, filter);
  const crossSell = filterPharmacyItems(base.crossSell, filter);
  const untappedBricks = filterBricks(base.untappedBricks, filter);
  const sum = (items: PharmacyActionItem[], pick: (item: PharmacyActionItem) => number) =>
    Math.round(items.reduce((total, item) => total + pick(item), 0) * 100) / 100;
  return {
    ...base,
    stopped,
    dropping,
    newPharmacies,
    top,
    crossSell,
    untappedBricks,
    counts: {
      activePharmacies: top.length,
      stopped: stopped.length,
      dropping: dropping.length,
      newPharmacies: newPharmacies.length,
      crossSell: crossSell.length,
      untappedBricks: untappedBricks.length,
    },
    valueAtStake: {
      stopped: sum(stopped, (item) => item.priorAverage),
      dropping: sum(dropping, (item) => item.priorAverage - item.latestValue),
      newPharmacies: sum(newPharmacies, (item) => item.latestValue),
    },
  };
}

export function PortalSosPharmacyActions({ subtitle }: { subtitle: string }) {
  const [line, setLine] = useState<string | null>(null);
  // The closing the lists are read AS OF. null = the newest published one, as the page always opened.
  const [period, setPeriod] = useState<string | null>(null);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [area, setArea] = useState("");
  const [tab, setTab] = useState<TabKey>("stopped");
  const [shown, setShown] = useState(PAGE_SIZE);
  // "Compare with the N closings before" — null = the default three. Reloads, like the month.
  const [months, setMonths] = useState<number | null>(null);
  // The advanced filters only narrow the lists already loaded; the sheet applies them to every pharmacy.
  const [brick, setBrick] = useState("");
  const [channel, setChannel] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (line) params.set("line", line);
    if (period) params.set("period", period);
    if (months) params.set("months", String(months));
    const query = params.toString() ? `?${params.toString()}` : "";
    fetch(`/api/employee-portals/source-of-sales/actions${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (result) => (await result.json()) as ApiResponse)
      .then((next) => {
        setResponse(next);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name === "AbortError") return;
        setResponse({ success: false, error: "Could not load your pharmacy actions." });
        setLoading(false);
      });
    return () => controller.abort();
  }, [line, period, months]);

  const data = response?.data;
  const actions = data?.actions ?? null;
  const pace = response?.pace ?? null;

  const areaOptions = useMemo(() => {
    const merged = new Map<string, string>();
    for (const option of actions?.areas ?? []) merged.set(option.code, option.name);
    for (const row of pace?.rows ?? []) if (!merged.has(row.areaCode)) merged.set(row.areaCode, row.areaName);
    return [...merged].map(([code, name]) => ({ code, name })).sort((left, right) => left.name.localeCompare(right.name));
  }, [actions, pace]);

  const selectTab = (next: TabKey) => {
    setTab(next);
    setShown(PAGE_SIZE);
  };
  const selectArea = (next: string) => {
    setArea(next);
    setBrick("");
    setShown(PAGE_SIZE);
  };
  const selectMonths = (next: number) => {
    setLoading(true);
    setShown(PAGE_SIZE);
    setMonths(next);
  };
  const clearFilters = () => {
    setBrick("");
    setChannel("");
    setSearch("");
    setShown(PAGE_SIZE);
  };
  const selectLine = (next: string) => {
    setLoading(true);
    setArea("");
    setShown(PAGE_SIZE);
    setPeriod(null);
    setBrick("");
    setLine(next);
  };
  const selectPeriod = (next: string) => {
    setLoading(true);
    setShown(PAGE_SIZE);
    setPeriod(next);
  };

  if (loading) return <LoadingState subtitle={subtitle} />;

  // The selectors sit on the band's bottom rail, like the period/line chips on the sibling pages.
  // Months the lists can be read as of: every published closing that has one before it to compare with.
  const monthOptions = (data?.publishedPeriods ?? []).slice(0, -1);
  const shownPeriod = actions?.latestPeriod ?? "";
  const bandFooter =
    (data?.availableLines.length ?? 0) > 1 || areaOptions.length > 1 || monthOptions.length > 1 ? (
      <>
        {data && data.availableLines.length > 1 ? (
          <BandChoice
            label="Line"
            // Re-choosing the line already shown would start a load the effect never finishes
            // (the `line` state does not change), so only a different line reloads.
            onSelect={(next) => {
              if (next !== (data.line ?? "")) selectLine(next);
            }}
            options={data.availableLines.map((option) => ({ value: option, label: option }))}
            selected={data.line ?? ""}
          />
        ) : null}
        {data && data.availableLines.length > 1 && (monthOptions.length > 1 || areaOptions.length > 1) ? (
          <span aria-hidden className="mx-2 hidden h-4 w-px bg-slate-200 sm:inline-block" />
        ) : null}
        {monthOptions.length > 1 ? (
          <label className="flex min-w-0 max-w-full items-center gap-2">
            <span className="whitespace-nowrap text-phx-xs font-black uppercase tracking-[0.18em] text-slate-500">Month</span>
            <select
              aria-label="Month"
              className={SELECT_CLASS}
              onChange={(event) => {
                if (event.target.value !== shownPeriod) selectPeriod(event.target.value);
              }}
              value={shownPeriod}
            >
              {monthOptions.map((option) => (
                <option key={option} value={option}>
                  {formatPeriod(option)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {monthOptions.length > 1 && areaOptions.length > 1 ? (
          <span aria-hidden className="mx-2 hidden h-4 w-px bg-slate-200 sm:inline-block" />
        ) : null}
        {areaOptions.length > 1 ? (
          <label className="flex min-w-0 max-w-full items-center gap-2">
            <span className="whitespace-nowrap text-phx-xs font-black uppercase tracking-[0.18em] text-slate-500">Area</span>
            <select aria-label="Area" className={SELECT_CLASS} onChange={(event) => selectArea(event.target.value)} value={area}>
              <option value="">All my areas</option>
              {areaOptions.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </>
    ) : undefined;

  if (!response?.success || !data) {
    return (
      <div className="space-y-6">
        <CommandBand surface="portal" kicker={BAND_KICKER} subtitle={subtitle} title={BAND_TITLE} />
        <SectionCard icon={Store} title="Where my sales come from">
          <p className="p-4 text-sm font-semibold text-slate-600">{response?.error ?? "Could not load your pharmacy actions."}</p>
        </SectionCard>
      </div>
    );
  }

  // Every count and every EGP figure on the band, the tiles and the tie-back line comes from ONE
  // source: the whole result, or the server's per-area summary when an area is picked. Never count
  // one and sum the other — the lists are capped, so a client-side sum undercounts.
  const areaScope: PharmacyAreaSummary | null = actions ? (area ? actions.byArea?.[area] ?? EMPTY_AREA : actions) : null;

  // The advanced filters narrow the lists on screen; counts and money then come from the narrowed lists.
  // The screen's lists hold the first ACTION_LIST_LIMIT of each, so when one was cut the note below
  // says so and points to the sheet, which filters every pharmacy.
  const listFilter: PharmacyListFilter = { brickName: brick || null, channel: readChannel(channel), search: search || null };
  const filterOn = hasListFilter(listFilter);
  const scope: PharmacyAreaSummary | null = areaScope && filterOn ? narrowScope(areaScope, listFilter) : areaScope;
  const listsCut = Boolean(
    areaScope &&
      (areaScope.stopped.length < areaScope.counts.stopped ||
        areaScope.dropping.length < areaScope.counts.dropping ||
        areaScope.newPharmacies.length < areaScope.counts.newPharmacies),
  );
  const brickOptions = areaScope
    ? brickOptionsOf([areaScope.stopped, areaScope.dropping, areaScope.newPharmacies, areaScope.top, areaScope.crossSell, areaScope.untappedBricks])
    : [];
  // Every closing published before the month shown, up to six — the choices "Compare with" offers.
  const publishedList = data.publishedPeriods ?? [];
  const shownIndex = actions?.latestPeriod ? publishedList.indexOf(actions.latestPeriod) : -1;
  const earlierAvailable = shownIndex >= 0 ? Math.min(MAX_LOOKBACK_CLOSINGS, publishedList.length - shownIndex - 1) : 0;
  const comparedWith = actions?.priorPeriods.length ?? 0;
  const monthsChoices = Array.from({ length: Math.max(earlierAvailable, comparedWith) }, (_, index) => index + 1);

  const renderList = (): ReactNode => {
    if (!actions) return null;
    const more = (total: number, full: number) => (
      <ShowMore full={Math.max(full, total)} onMore={() => setShown((current) => current + PAGE_SIZE)} shown={Math.min(shown, total)} total={total} />
    );
    if (tab === "crossSell") {
      const list = scope?.crossSell ?? [];
      const columns: Column<CrossSellItem>[] = [
        { label: "Latest closing", width: "18%", align: "right", render: (item) => formatEgp(item.latestValue) },
        {
          label: "Not buying",
          width: "36%",
          render: (item) => (
            <div className="flex flex-wrap gap-1">
              {item.missingProducts.map((product) => (
                <span key={product.code} className="border border-slate-200 bg-white px-1.5 py-0.5 text-phx-xs font-bold text-slate-700">
                  {product.name}
                </span>
              ))}
            </div>
          ),
        },
      ];
      return (
        <>
          <ResponsiveTable
            columns={columns}
            emptyText="No gaps: every active pharmacy that buys your core products buys all of them."
            items={list.slice(0, shown)}
            lead={pharmacyLead as Column<CrossSellItem>}
          />
          {more(list.length, countOf("crossSell"))}
        </>
      );
    }
    if (tab === "untappedBricks") {
      const list = (scope?.untappedBricks ?? []).map((brick: BrickUniverseEntry) => ({ ...brick, key: brick.brickId }));
      const lead: Column<(typeof list)[number]> = {
        label: "Brick",
        width: "60%",
        render: (brick) => <span className="break-words text-sm font-bold text-slate-900">{brick.brickName}</span>,
      };
      const columns: Column<(typeof list)[number]>[] = [{ label: "Area", width: "40%", render: (brick) => brick.areaName }];
      return (
        <>
          <ResponsiveTable columns={columns} emptyText="Every brick in your areas had a pharmacy buying." items={list.slice(0, shown)} lead={lead} />
          {more(list.length, countOf("untappedBricks"))}
        </>
      );
    }

    const list = scope?.[tab as "stopped" | "dropping" | "newPharmacies" | "top"] ?? [];
    const latest: Column<PharmacyActionItem> = { label: "Latest closing", width: "18%", align: "right", render: (item) => formatEgp(item.latestValue) };
    const earlier = actions.priorPeriods.length;
    const average: Column<PharmacyActionItem> = {
      label: earlier === 1 ? "Month before" : `${earlier}-closing average`,
      width: "18%",
      align: "right",
      render: (item) => formatEgp(item.priorAverage),
    };
    const columnsByTab: Record<"stopped" | "dropping" | "newPharmacies" | "top", Column<PharmacyActionItem>[]> = {
      stopped: [average, { label: "Last bought", width: "18%", align: "right", render: (item) => formatPeriod(item.lastBoughtPeriod) }],
      dropping: [latest, average, { label: "Change", width: "18%", align: "right", render: (item) => <ChangePill change={item.change} /> }],
      newPharmacies: [latest],
      top: [latest, { label: "Share", width: "18%", align: "right", render: (item) => (item.share == null ? "—" : formatPct(item.share)) }],
    };
    const emptyByTab: Record<"stopped" | "dropping" | "newPharmacies" | "top", string> = {
      stopped: "No pharmacy stopped buying.",
      dropping: "No pharmacy dropped 30% or more.",
      newPharmacies: "No new pharmacy in the latest closing.",
      top: "No pharmacy sales in the latest closing.",
    };
    return (
      <>
        <ResponsiveTable columns={columnsByTab[tab]} emptyText={emptyByTab[tab]} items={list.slice(0, shown)} lead={pharmacyLead} />
        {more(list.length, countOf(tab))}
      </>
    );
  };

  const activeTab = TABS.find((entry) => entry.key === tab) ?? TABS[0];
  const countOf = (key: TabKey): number => {
    if (!scope) return 0;
    if (filterOn && key === "top") return scope.top.length;
    return key === "top" ? scope.counts.activePharmacies : scope.counts[key];
  };
  const totals = scope?.latestTotals;
  const stake = scope?.valueAtStake ?? EMPTY_AREA.valueAtStake;
  const tieBack = totals
    ? [
        `pharmacies ${formatEgp(totals.pharmacies)}`,
        totals.mainStores > 0 ? `Main Stores ${formatEgp(totals.mainStores)}` : null,
        totals.wholesalerShares > 0 ? `wholesaler shares ${formatEgp(totals.wholesalerShares)}` : null,
        totals.noCustomerCode > 0 ? `no customer code ${formatEgp(totals.noCustomerCode)}` : null,
      ].filter(Boolean)
    : [];

  // Headline stats: the latest PUBLISHED closing only. Weekly pace never appears here. The buying
  // pharmacies count is NOT repeated here: it is the fourth tile below, the one that opens its list.
  const bandStats = actions ? (
    <>
      <BandStat
        label="Latest closing"
        note={`${data.line ? `${data.line} · ` : ""}${formatPeriod(actions.latestPeriod)}`}
        value={formatEgp(totals?.total ?? 0)}
      />
      <BandStat
        label="Value at stake"
        note={`${formatEgp(stake.stopped)} stopped · ${formatEgp(stake.dropping)} dropping`}
        tone="amber"
        value={formatEgp(stake.stopped + stake.dropping)}
      />
    </>
  ) : undefined;

  return (
    <div className="space-y-6">
      <CommandBand surface="portal" footer={bandFooter} kicker={BAND_KICKER} stats={bandStats} subtitle={subtitle} title={BAND_TITLE} />

      <SectionCard
        actions={
          actions ? (
            <a
              className={landingActionClassName("outline")}
              href={`/api/employee-portals/source-of-sales/actions/export?${new URLSearchParams({
                ...(data.line ? { line: data.line } : {}),
                ...(actions.latestPeriod ? { period: actions.latestPeriod } : {}),
                ...(area ? { area } : {}),
                ...(comparedWith > 0 ? { months: String(comparedWith) } : {}),
                ...(brick ? { brick } : {}),
                ...(listFilter.channel ? { channel: listFilter.channel } : {}),
                ...(search.trim() ? { q: search.trim() } : {}),
              }).toString()}`}
            >
              <Download className="h-3 w-3" />
              Download sheet
            </a>
          ) : undefined
        }
        icon={Store}
        title="Where my sales come from"
      >
        <div className="p-4">
          {!actions ? (
            <p className="text-sm font-semibold text-slate-600">{data.message ?? "No published closing to read yet."}</p>
          ) : (
            <>
              <p className="mb-4 text-sm leading-6 text-slate-600">
                {closingIntro({
                  line: data.line,
                  latestPeriod: actions.latestPeriod,
                  priorPeriods: actions.priorPeriods,
                  historyComplete: actions.historyComplete,
                })}
              </p>

              <div className="mb-4 grid grid-cols-1 gap-3 border border-slate-200 bg-slate-50/60 p-3 sm:grid-cols-2 lg:grid-cols-5">
                {monthsChoices.length > 0 ? (
                  <label className="min-w-0">
                    <span className={FILTER_LABEL}>Compare with</span>
                    <select
                      aria-label="Compare with"
                      className={cn(SELECT_CLASS, "w-full")}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (next !== comparedWith) selectMonths(next);
                      }}
                      value={comparedWith}
                    >
                      {monthsChoices.map((choice) => (
                        <option key={choice} value={choice}>
                          {`${choice === 1 ? "The month before" : `The ${choice} months before`}${choice === LOOKBACK_CLOSINGS ? " (usual)" : ""}`}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {brickOptions.length > 1 ? (
                  <label className="min-w-0">
                    <span className={FILTER_LABEL}>Brick</span>
                    <select
                      aria-label="Brick"
                      className={cn(SELECT_CLASS, "w-full")}
                      onChange={(event) => {
                        setBrick(event.target.value);
                        setShown(PAGE_SIZE);
                      }}
                      value={brick}
                    >
                      <option value="">Every brick</option>
                      {brickOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="min-w-0">
                  <span className={FILTER_LABEL}>Bought through</span>
                  <select
                    aria-label="Bought through"
                    className={cn(SELECT_CLASS, "w-full")}
                    onChange={(event) => {
                      setChannel(event.target.value);
                      setShown(PAGE_SIZE);
                    }}
                    value={channel}
                  >
                    <option value="">Distributor and direct</option>
                    <option value="distributor">Distributor only</option>
                    <option value="direct">Direct order only</option>
                  </select>
                </label>
                <label className="min-w-0">
                  <span className={FILTER_LABEL}>Search</span>
                  <input
                    aria-label="Search pharmacies"
                    className={SEARCH_CLASS}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setShown(PAGE_SIZE);
                    }}
                    placeholder="Pharmacy, address or brick"
                    type="search"
                    value={search}
                  />
                </label>
                <div className="flex min-w-0 items-end">
                  {filterOn ? (
                    <button className={cn(phxButtonGhostClassName, "min-h-10 w-full text-xs md:min-h-0")} onClick={clearFilters} type="button">
                      Clear filters
                    </button>
                  ) : null}
                </div>
              </div>
              {filterOn && listsCut ? (
                <p className="-mt-2 mb-4 text-phx-xs font-semibold text-amber-700">
                  The screen holds the first 200 pharmacies of each list, so these counts may be short. Download sheet applies the same filters to every pharmacy.
                </p>
              ) : null}

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Tile
                  accent="#EF4444"
                  active={tab === "stopped"}
                  icon={Ban}
                  label="Stopped buying"
                  onClick={() => selectTab("stopped")}
                  sub={`${formatEgp(stake.stopped)} a month before`}
                  value={count(countOf("stopped"))}
                />
                <Tile
                  accent="#F97316"
                  active={tab === "dropping"}
                  icon={TrendingDown}
                  label="Dropping 30%+"
                  onClick={() => selectTab("dropping")}
                  sub={`${formatEgp(stake.dropping)} below average`}
                  value={count(countOf("dropping"))}
                />
                <Tile
                  accent="#22C55E"
                  active={tab === "newPharmacies"}
                  icon={UserPlus}
                  label="New this closing"
                  onClick={() => selectTab("newPharmacies")}
                  sub={`${formatEgp(stake.newPharmacies)} in their first month`}
                  value={count(countOf("newPharmacies"))}
                />
                <Tile
                  accent="#0EA5E9"
                  active={tab === "top"}
                  icon={Store}
                  label="Buying pharmacies"
                  onClick={() => selectTab("top")}
                  sub={`${formatEgp(totals?.pharmacies ?? 0)} in the latest closing`}
                  value={count(countOf("top"))}
                />
              </div>

              {!filterOn && totals && totals.total > 0 ? (
                <p className="mt-4 border-l-2 border-slate-300 pl-3 text-phx-xs font-semibold leading-5 text-slate-500">
                  {`Your ${formatPeriod(actions.latestPeriod)} closing: ${formatEgp(totals.total)} = ${tieBack.join(" + ")}. Only pharmacies are listed — Main Stores and wholesaler shares are split across areas and have no single pharmacy to visit.`}
                </p>
              ) : null}

              <div className="mt-5 flex flex-wrap gap-1.5 border-b border-slate-100 pb-3">
                {TABS.map((entry) => {
                  const selected = entry.key === tab;
                  return (
                    <button
                      key={entry.key}
                      aria-pressed={selected}
                      className={`${chipClass(selected, "portal")} ${TAP_CHIP}`}
                      onClick={() => selectTab(entry.key)}
                      type="button"
                    >
                      {entry.label}
                      {entry.key === "top" ? null : (
                        <span className={`ml-1 tabular-nums ${selected ? "text-white/65" : "text-slate-400"}`}>{`· ${count(countOf(entry.key))}`}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mb-3 mt-3 text-phx-xs font-semibold text-slate-500">{activeTab.hint(actions.priorPeriods.length)}</p>
              {renderList()}
            </>
          )}
        </div>
      </SectionCard>

      {pace ? <MonthPace area={area} pace={pace} /> : null}
      {!pace && data.line ? (
        <SectionCard icon={Gauge} title="Month pace · weekly, approximate">
          <p className="flex items-center gap-2 p-4 text-sm font-semibold text-slate-500">
            <Gauge className="h-4 w-4 shrink-0" />
            Weekly pace is not available for your scope right now.
          </p>
        </SectionCard>
      ) : null}
    </div>
  );
}
