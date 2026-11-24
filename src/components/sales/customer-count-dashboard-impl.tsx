"use client";

// THE CUSTOMER COUNT DASHBOARD — how many pharmacies bought, month by month, cut by line, product,
// region, area, brick and medical rep. One component, two doors: the admin page and a manager's
// portal page, each passing its own endpoint (the server decides the scope; this only draws it).
//
// Every number is a count of DISTINCT pharmacies (customer-count-dashboard.ts): a total is never the
// sum of the rows above it, so no total row is drawn and the export adds none.
//
// THE LOOK (owner, 24 Nov 2026: "a big premium polish … centre the numbers in the table"): flat
// colour only — orange for the month that matters, slate for the months behind it, emerald and rose
// for who came and who went. No gradient, glow or rounded corner; figures sit on the bars so the
// chart reads without the tooltip; every number in the table is centred.

import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Boxes,
  CalendarRange,
  Layers,
  Loader2,
  MapPinned,
  Minus,
  Repeat,
  Store,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";

import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { MultiSelectFilter, type MultiSelectFilterMode } from "@/components/ui/multi-select-filter";
import { TableSearchInput } from "@/components/ui/sortable-table";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import {
  breakdown,
  DIMENSION_LABELS,
  filterFacts,
  monthTrend,
  summarize,
  type CustomerCountDimension,
  type CustomerCountPayload,
} from "@/lib/sales/customer-count-dashboard";
import { formatNumber } from "@/lib/sales/format";

const ORANGE = "#EA580C";
const ORANGE_SOFT = "#FDBA74";
const PRIOR = "#CBD5E1";
const INK = "#0F172A";
const GAIN = "#047857";
const LOSS = "#BE123C";
const GRID = "#EEF2F6";
const AXIS = { fontSize: 10, fontWeight: 700, fill: "#64748B" } as const;
const BAR_LABEL = { fontSize: 10, fontWeight: 800, fill: "#334155" } as const;

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function monthShort(period: string | null | undefined): string {
  if (!period) return "";
  const [year, month] = period.split("-").map(Number);
  return `${MONTH_NAMES[(month || 1) - 1]} ${year}`;
}
function monthLong(period: string | null | undefined): string {
  if (!period) return "";
  const [year, month] = period.split("-").map(Number);
  return `${MONTH_LONG[(month || 1) - 1]} ${year}`;
}

/** 12,697 → "12.7k" for an axis; the bars and the table always carry the full figure. */
function compact(value: number): string {
  const size = Math.abs(value);
  if (size >= 10_000) return `${Math.round(value / 1000)}k`;
  if (size >= 1_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${value}`;
}

type Choice = { selected: string[]; mode: MultiSelectFilterMode };
const ALL: Choice = { selected: [], mode: "include" };

/** The indexes a choice keeps, or undefined for "all". */
function chosen(choice: Choice, codes: string[]): number[] | undefined {
  if (choice.selected.length === 0) return undefined;
  const picked = new Set(choice.selected);
  return codes
    .map((code, index) => ({ code, index }))
    .filter(({ code }) => (choice.mode === "include" ? picked.has(code) : !picked.has(code)))
    .map(({ index }) => index);
}

function Change({ value }: { value: number | null }) {
  if (value == null) return <span className="text-slate-300">—</span>;
  if (value === 0)
    return (
      <span className="inline-flex items-center gap-0.5 font-black tabular-nums text-slate-500">
        <Minus className="h-3 w-3" />0
      </span>
    );
  const up = value > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 font-black tabular-nums ${up ? "text-emerald-700" : "text-rose-700"}`}>
      {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {up ? "+" : "−"}
      {formatNumber(Math.abs(value))}
    </span>
  );
}

/** A month-by-month line, last point marked. Scales evenly, so the dot stays round. */
function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <div aria-hidden="true" className="mt-3 h-[26px]" />;
  const width = 120;
  const height = 26;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => [
    3 + (index / (values.length - 1)) * (width - 6),
    height - 4 - ((value - min) / span) * (height - 8),
  ]);
  const [lastX, lastY] = points[points.length - 1];
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} className="mt-3 block h-[26px] w-full">
      <line x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} stroke="#E2E8F0" strokeWidth="1" />
      <polyline points={points.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r="2.6" fill={color} />
    </svg>
  );
}

/** The months of one row as tiny bars, the latest in orange — the row's own shape at a glance. */
function MicroBars({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const step = 7;
  const width = Math.max(step * values.length - 2, 1);
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} 22`} className="mx-auto block h-[22px]" style={{ width: Math.min(width, 84) }} preserveAspectRatio="none">
      {values.map((value, index) => {
        const barHeight = Math.max(value > 0 ? 2 : 0, (value / max) * 20);
        return (
          <rect
            key={index}
            x={index * step}
            y={22 - barHeight}
            width={5}
            height={barHeight}
            fill={index === values.length - 1 ? ORANGE : PRIOR}
          />
        );
      })}
    </svg>
  );
}

function Tile({
  label,
  value,
  sub,
  icon,
  rule,
  valueClass = "text-slate-900",
  change,
  spark,
  share,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  rule: string;
  valueClass?: string;
  change?: number | null;
  spark?: { values: number[]; color: string };
  share?: { value: number; label: string };
}) {
  return (
    <div className="relative flex min-w-0 flex-col border border-slate-200 bg-white px-4 pb-3 pt-4">
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px]" style={{ backgroundColor: rule }} />
      <div className="flex items-start justify-between gap-2">
        <p className="text-phx-sm font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
        <span className="text-slate-300">{icon}</span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={`text-[1.75rem] font-black tabular-nums leading-none tracking-tight ${valueClass}`}>{value}</span>
        {change !== undefined ? (
          <span className="text-xs">
            <Change value={change} />
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 text-phx-xs font-semibold leading-snug text-slate-500">{sub}</p>
      <div className="mt-auto">
        {spark ? <Spark values={spark.values} color={spark.color} /> : null}
        {share ? (
          <div className="mt-3">
            <div className="h-[6px] w-full bg-slate-100">
              <div className="h-full" style={{ width: `${Math.min(100, Math.max(0, share.value * 100))}%`, backgroundColor: INK }} />
            </div>
            <p className="mt-1.5 text-phx-xs font-bold tabular-nums text-slate-600">{share.label}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  icon,
  action,
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 border border-slate-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="h-8 w-[3px] shrink-0 bg-orange-600" />
          <span className="text-orange-600">{icon}</span>
          <div className="min-w-0">
            <h3 className="text-[0.95rem] font-black tracking-tight text-slate-900">{title}</h3>
            <p className="text-xs text-slate-500">{subtitle}</p>
          </div>
        </div>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A chart key: flat squares, the words beside them. */
function Key({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5 text-phx-xs font-bold text-slate-600">
          <span aria-hidden="true" className="h-2.5 w-2.5" style={{ backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function CountTooltip({ active, payload, label }: { active?: boolean; payload?: Array<Record<string, unknown>>; label?: unknown }) {
  if (!active || !payload || payload.length === 0) return null;
  const first = payload[0]?.payload as Record<string, unknown> | undefined;
  const depth = typeof first?.depth === "number" ? first.depth : null;
  return (
    <div className="min-w-[180px] border border-slate-900 bg-white">
      <p className="bg-slate-900 px-3 py-1.5 text-phx-sm font-black uppercase tracking-wider text-white">{String(label ?? "")}</p>
      <div className="space-y-1 px-3 py-2">
        {payload.map((entry, index) => (
          <div key={index} className="flex items-center justify-between gap-4 text-phx-xs">
            <span className="flex items-center gap-2 font-bold text-slate-600">
              <span className="h-2 w-2" style={{ backgroundColor: String(entry.color ?? entry.fill ?? "#94A3B8") }} />
              {String(entry.name ?? "")}
            </span>
            {/* Lost is drawn below the line as a negative bar; it is still a count of pharmacies. */}
            <span className="font-black tabular-nums text-slate-900">{formatNumber(Math.abs(Number(entry.value ?? 0)))}</span>
          </div>
        ))}
        {depth != null ? (
          <div className="flex items-center justify-between gap-4 border-t border-slate-100 pt-1 text-phx-xs">
            <span className="font-bold text-slate-600">Products each</span>
            <span className="font-black tabular-nums text-slate-900">{depth.toFixed(2)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const DIMENSIONS: CustomerCountDimension[] = ["line", "product", "region", "area", "brick", "rep"];

export function CustomerCountDashboard({ endpoint }: { endpoint: string }) {
  const [payload, setPayload] = useState<CustomerCountPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Lines and months are read by the server (each is a closing read); the rest filter on screen.
  const [months, setMonths] = useState<Choice>(ALL);
  const [lines, setLines] = useState<Choice>(ALL);
  const [regions, setRegions] = useState<Choice>(ALL);
  const [areas, setAreas] = useState<Choice>(ALL);
  const [products, setProducts] = useState<Choice>(ALL);
  const [reps, setReps] = useState<Choice>(ALL);
  const [dimension, setDimension] = useState<CustomerCountDimension>("area");
  const [query, setQuery] = useState("");

  const availableMonths = payload?.availableMonths;
  const availableLines = payload?.availableLines;
  const requestedMonths = useMemo(() => {
    if (!availableMonths || months.selected.length === 0) return [] as string[];
    return months.mode === "include" ? months.selected : availableMonths.filter((month) => !months.selected.includes(month));
  }, [months, availableMonths]);
  const requestedLines = useMemo(() => {
    if (!availableLines || lines.selected.length === 0) return [] as string[];
    return lines.mode === "include" ? lines.selected : availableLines.filter((line) => !lines.selected.includes(line));
  }, [lines, availableLines]);
  const linesParam = requestedLines.join(",");
  const monthsParam = requestedMonths.join(",");

  // Each fetch settles into state from its own callback (never synchronously in the effect), and the
  // loading flag is simply "the last settled request is not the one on screen".
  const requestKey = `${endpoint}|${linesParam}|${monthsParam}`;
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const loading = settledKey !== requestKey;

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (linesParam) params.set("lines", linesParam);
    if (monthsParam) params.set("months", monthsParam);
    const search = params.toString();
    fetch(`${endpoint}${search ? `?${search}` : ""}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as { success?: boolean; data?: CustomerCountPayload; error?: string } | null;
        if (!response.ok || !body?.success || !body.data) throw new Error(body?.error || "The customer count could not be read.");
        setPayload(body.data);
        setError(null);
        setSettledKey(requestKey);
      })
      .catch((caught: unknown) => {
        if ((caught as { name?: string })?.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "The customer count could not be read.");
        setSettledKey(requestKey);
      });
    return () => controller.abort();
  }, [endpoint, linesParam, monthsParam, requestKey]);

  const view = useMemo(() => {
    if (!payload) return null;
    const facts = filterFacts(payload, {
      regions: chosen(regions, payload.regions),
      areas: chosen(areas, payload.areas.map((area) => area.code)),
      products: chosen(products, payload.products.map((_, index) => `${index}`)),
      reps: chosen(reps, payload.reps),
    });
    return {
      summary: summarize(payload, facts),
      trend: monthTrend(payload, facts),
      rows: breakdown(payload, facts, dimension),
    };
  }, [payload, regions, areas, products, reps, dimension]);

  const visibleRows = useMemo(() => {
    if (!view) return [];
    const needle = query.trim().toLowerCase();
    return needle ? view.rows.filter((row) => `${row.label} ${row.parent}`.toLowerCase().includes(needle)) : view.rows;
  }, [view, query]);

  if (!payload || !view) {
    return (
      <div className="flex min-h-[320px] items-center justify-center border border-slate-200 bg-white p-6 text-sm text-slate-600">
        {error ? (
          <p className="max-w-lg border-l-4 border-rose-500 bg-white px-4 py-3 text-rose-800">{error}</p>
        ) : (
          <span className="inline-flex items-center gap-2 font-semibold">
            <Loader2 className="h-4 w-4 animate-spin" />
            Counting the pharmacies in each published closing…
          </span>
        )}
      </div>
    );
  }

  const monthsOnShow = payload.months;
  const multiMonth = monthsOnShow.length > 1;
  const latestLabel = monthShort(monthsOnShow.at(-1));
  const priorLabel = monthShort(monthsOnShow.at(-2));
  const { summary } = view;
  const trendData = view.trend.map((point) => ({
    month: monthShort(point.month),
    Pharmacies: point.pharmacies,
    Gained: point.gained ?? 0,
    // Drawn below the zero line; the tooltip and the labels show it as the count it is.
    Lost: -(point.lost ?? 0),
    net: (point.gained ?? 0) - (point.lost ?? 0),
    depth: Number(point.productsPerPharmacy.toFixed(2)),
  }));
  const flowData = trendData.slice(1);
  const top = visibleRows.slice(0, 12).map((row) => ({
    name: row.label,
    [latestLabel]: row.perMonth.at(-1) ?? 0,
    ...(multiMonth ? { [priorLabel]: row.perMonth.at(-2) ?? 0 } : {}),
  }));
  const hasParent = dimension === "product" || dimension === "area" || dimension === "brick";
  const parentLabel = dimension === "product" ? "Line" : dimension === "area" ? "Region" : "Area";
  const latestMax = Math.max(1, ...visibleRows.map((row) => row.perMonth.at(-1) ?? 0));

  const exportColumns: ExportColumn[] = [
    { key: "label", label: DIMENSION_LABELS[dimension], text: true, width: 28 },
    ...(hasParent ? [{ key: "parent", label: parentLabel, text: true, width: 22 } satisfies ExportColumn] : []),
    ...monthsOnShow.map((month): ExportColumn => ({ key: month, label: monthShort(month), numeric: true, excludeFromTotal: true, width: 12 })),
    ...(multiMonth
      ? ([
          { key: "change", label: `Change vs ${priorLabel}`, numeric: true, excludeFromTotal: true, width: 14 },
          { key: "total", label: `Any of the ${monthsOnShow.length} months`, numeric: true, excludeFromTotal: true, width: 16 },
        ] satisfies ExportColumn[])
      : []),
  ];
  const exportRows: ExportRow[] = visibleRows.map((row) => ({
    label: row.label,
    parent: row.parent,
    ...Object.fromEntries(monthsOnShow.map((month, index) => [month, row.perMonth[index] ?? 0])),
    change: row.change,
    total: row.total,
  }));
  const trendColumns: ExportColumn[] = [
    { key: "month", label: "Month", text: true, width: 16 },
    { key: "pharmacies", label: "Pharmacies that bought", numeric: true, excludeFromTotal: true, width: 18 },
    { key: "gained", label: "Gained vs month before", numeric: true, excludeFromTotal: true, width: 18 },
    { key: "lost", label: "Lost vs month before", numeric: true, excludeFromTotal: true, width: 18 },
    { key: "depth", label: "Products per pharmacy", numeric: true, excludeFromTotal: true, width: 18 },
  ];
  const trendRows: ExportRow[] = view.trend.map((point) => ({
    month: monthLong(point.month),
    pharmacies: point.pharmacies,
    gained: point.gained,
    lost: point.lost,
    depth: Number(point.productsPerPharmacy.toFixed(2)),
  }));
  const scopeLine = `${requestedLines.length > 0 ? requestedLines.join(", ") : payload.lines.length === 1 ? payload.lines[0] : "All lines"} · ${monthLong(monthsOnShow[0])}${multiMonth ? ` to ${monthLong(monthsOnShow.at(-1))}` : ""}`;

  const productOptions = payload.products.map((product, index) => ({
    code: `${index}`,
    label: payload.lines.length > 1 ? `${product.name} · ${payload.lines[product.line]}` : product.name,
  }));

  const pharmacySeries = view.trend.map((point) => point.pharmacies);
  const gainedSeries = view.trend.slice(1).map((point) => point.gained ?? 0);
  const lostSeries = view.trend.slice(1).map((point) => point.lost ?? 0);
  const depthSeries = view.trend.map((point) => point.productsPerPharmacy);
  const loyalShare = summary.reached > 0 ? summary.everyMonth / summary.reached : 0;
  const latestShare = summary.reached > 0 ? summary.latest / summary.reached : 0;

  return (
    <div className="min-w-0 space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border border-slate-200 bg-white p-3">
        <MultiSelectFilter
          label="Months"
          icon={<CalendarRange className="h-3.5 w-3.5" />}
          options={payload.availableMonths.map((month) => ({ code: month, label: monthLong(month) }))}
          selected={months.selected}
          mode={months.mode}
          onSelectedChange={(selected) => setMonths((current) => ({ ...current, selected }))}
          onModeChange={(mode) => setMonths((current) => ({ ...current, mode }))}
          allLabel="Latest 6"
          searchable={false}
        />
        {payload.availableLines.length > 1 ? (
          <MultiSelectFilter
            label="Line"
            icon={<Layers className="h-3.5 w-3.5" />}
            options={payload.availableLines.map((line) => ({ code: line, label: line }))}
            selected={lines.selected}
            mode={lines.mode}
            onSelectedChange={(selected) => setLines((current) => ({ ...current, selected }))}
            onModeChange={(mode) => setLines((current) => ({ ...current, mode }))}
            searchable={false}
          />
        ) : null}
        <MultiSelectFilter
          label="Region"
          icon={<MapPinned className="h-3.5 w-3.5" />}
          options={payload.regions.map((region) => ({ code: region, label: region }))}
          selected={regions.selected}
          mode={regions.mode}
          onSelectedChange={(selected) => setRegions((current) => ({ ...current, selected }))}
          onModeChange={(mode) => setRegions((current) => ({ ...current, mode }))}
        />
        <MultiSelectFilter
          label="Area"
          icon={<MapPinned className="h-3.5 w-3.5" />}
          options={payload.areas.map((area) => ({ code: area.code, label: area.name || area.code }))}
          selected={areas.selected}
          mode={areas.mode}
          onSelectedChange={(selected) => setAreas((current) => ({ ...current, selected }))}
          onModeChange={(mode) => setAreas((current) => ({ ...current, mode }))}
        />
        <MultiSelectFilter
          label="Product"
          icon={<Boxes className="h-3.5 w-3.5" />}
          options={productOptions}
          selected={products.selected}
          mode={products.mode}
          onSelectedChange={(selected) => setProducts((current) => ({ ...current, selected }))}
          onModeChange={(mode) => setProducts((current) => ({ ...current, mode }))}
        />
        <MultiSelectFilter
          label="Medical Rep"
          icon={<Users className="h-3.5 w-3.5" />}
          options={payload.reps.map((rep) => ({ code: rep, label: rep }))}
          selected={reps.selected}
          mode={reps.mode}
          onSelectedChange={(selected) => setReps((current) => ({ ...current, selected }))}
          onModeChange={(mode) => setReps((current) => ({ ...current, mode }))}
        />
        <span className="ml-auto inline-flex items-center gap-2 border-l-2 border-orange-600 pl-3 text-xs font-bold text-slate-700">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {scopeLine}
        </span>
      </div>

      {error ? <p className="border-l-4 border-rose-500 bg-white px-4 py-3 text-sm text-rose-800">{error}</p> : null}
      {payload.unpublished.length > 0 ? (
        <p className="border-l-4 border-amber-500 bg-white px-4 py-2 text-xs text-slate-700">
          Not published yet, so not counted: {payload.unpublished.map((entry) => `${entry.line} ${monthLong(entry.month)}`).join(", ")}.
        </p>
      ) : null}

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile
          rule={ORANGE}
          label="Pharmacies buying"
          icon={<Store className="h-4 w-4" />}
          value={formatNumber(summary.latest)}
          valueClass="text-orange-700"
          change={summary.previous == null ? undefined : summary.latest - summary.previous}
          sub={summary.previousMonth ? `${monthLong(summary.latestMonth)}, against ${formatNumber(summary.previous ?? 0)} in ${monthShort(summary.previousMonth)}` : monthLong(summary.latestMonth)}
          spark={{ values: pharmacySeries, color: ORANGE }}
        />
        <Tile
          rule={GAIN}
          label="Gained"
          icon={<UserPlus className="h-4 w-4" />}
          value={summary.gained == null ? "—" : formatNumber(summary.gained)}
          valueClass="text-emerald-700"
          sub={summary.previousMonth ? `bought in ${monthShort(summary.latestMonth)}, not in ${monthShort(summary.previousMonth)}` : "needs two months"}
          spark={{ values: gainedSeries, color: GAIN }}
        />
        <Tile
          rule={LOSS}
          label="Lost"
          icon={<UserMinus className="h-4 w-4" />}
          value={summary.lost == null ? "—" : formatNumber(summary.lost)}
          valueClass="text-rose-700"
          sub={summary.previousMonth ? `bought in ${monthShort(summary.previousMonth)}, not in ${monthShort(summary.latestMonth)}` : "needs two months"}
          spark={{ values: lostSeries, color: LOSS }}
        />
        <Tile
          rule={INK}
          label="Reached"
          icon={<Users className="h-4 w-4" />}
          value={formatNumber(summary.reached)}
          sub={multiMonth ? `bought in any of the ${monthsOnShow.length} months` : "bought this month"}
          share={multiMonth ? { value: latestShare, label: `${Math.round(latestShare * 100)}% of them bought in ${monthShort(summary.latestMonth)}` } : undefined}
        />
        <Tile
          rule={INK}
          label="Every month"
          icon={<Repeat className="h-4 w-4" />}
          value={formatNumber(summary.everyMonth)}
          sub={multiMonth ? `bought in all ${monthsOnShow.length} months` : "bought this month"}
          share={multiMonth ? { value: loyalShare, label: `${(loyalShare * 100).toFixed(1)}% of every pharmacy reached` } : undefined}
        />
        <Tile
          rule={INK}
          label="Products each"
          icon={<Boxes className="h-4 w-4" />}
          value={summary.productsPerPharmacy.toFixed(2)}
          sub={`average per buying pharmacy, ${monthShort(summary.latestMonth)}`}
          spark={{ values: depthSeries, color: INK }}
        />
      </div>

      {/* Trend */}
      <div className="grid min-w-0 gap-4 xl:grid-cols-5">
        <div className="min-w-0 xl:col-span-3">
          <Panel
            title="Pharmacies buying, month by month"
            subtitle="Each pharmacy once a month, whatever it bought"
            icon={<BarChart3 className="h-4 w-4" />}
            action={<ExportXlsxButton columns={trendColumns} rows={trendRows} title="Customer Count by Month" subtitle={scopeLine} sheetName="By Month" />}
          >
            <div className="mb-2">
              <Key items={[{ label: latestLabel, color: ORANGE }, ...(multiMonth ? [{ label: "Months before", color: ORANGE_SOFT }] : [])]} />
            </div>
            <SafeResponsiveContainer minHeight={260}>
              <BarChart data={trendData} margin={{ top: 22, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="month" axisLine={{ stroke: INK }} tickLine={false} tick={AXIS} />
                <YAxis axisLine={false} tickLine={false} tick={AXIS} width={40} allowDecimals={false} tickFormatter={compact} />
                <Tooltip content={<CountTooltip />} cursor={{ fill: "#FFF7ED" }} />
                <Bar dataKey="Pharmacies" maxBarSize={56} isAnimationActive={false}>
                  {trendData.map((point, index) => (
                    <Cell key={point.month} fill={index === trendData.length - 1 ? ORANGE : ORANGE_SOFT} />
                  ))}
                  <LabelList dataKey="Pharmacies" position="top" formatter={(value: unknown) => formatNumber(Number(value))} style={BAR_LABEL} />
                </Bar>
              </BarChart>
            </SafeResponsiveContainer>
            {/* How deep each month went: the products a buying pharmacy took, on average. */}
            <div className="mt-3 grid border-t border-slate-200 pt-2" style={{ gridTemplateColumns: `repeat(${trendData.length}, minmax(0, 1fr))` }}>
              {trendData.map((point, index) => (
                <div key={point.month} className="text-center">
                  <p className={`text-sm font-black tabular-nums ${index === trendData.length - 1 ? "text-slate-900" : "text-slate-500"}`}>{point.depth.toFixed(2)}</p>
                  <p className="text-phx-xs font-semibold text-slate-400">products each</p>
                </div>
              ))}
            </div>
          </Panel>
        </div>
        <div className="min-w-0 xl:col-span-2">
          <Panel title="Gained and lost" subtitle="Against the month before" icon={<Repeat className="h-4 w-4" />}>
            {multiMonth ? (
              <>
                <div className="mb-2">
                  <Key
                    items={[
                      { label: "Gained", color: GAIN },
                      { label: "Lost", color: LOSS },
                    ]}
                  />
                </div>
                <SafeResponsiveContainer minHeight={260}>
                  <BarChart data={flowData} stackOffset="sign" margin={{ top: 20, right: 8, bottom: 20, left: 0 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="month" axisLine={false} tickLine={false} tick={AXIS} />
                    <YAxis axisLine={false} tickLine={false} tick={AXIS} width={40} allowDecimals={false} tickFormatter={(value: number) => compact(Math.abs(value))} />
                    <Tooltip content={<CountTooltip />} cursor={{ fill: "#F8FAFC" }} />
                    <ReferenceLine y={0} stroke={INK} strokeWidth={1.5} />
                    <Bar dataKey="Gained" stackId="flow" fill={GAIN} maxBarSize={44} isAnimationActive={false}>
                      <LabelList dataKey="Gained" position="top" formatter={(value: unknown) => formatNumber(Number(value))} style={{ ...BAR_LABEL, fill: GAIN }} />
                    </Bar>
                    <Bar dataKey="Lost" stackId="flow" fill={LOSS} maxBarSize={44} isAnimationActive={false}>
                      <LabelList dataKey="Lost" position="bottom" formatter={(value: unknown) => formatNumber(Math.abs(Number(value)))} style={{ ...BAR_LABEL, fill: LOSS }} />
                    </Bar>
                  </BarChart>
                </SafeResponsiveContainer>
                {/* The net of the two, month by month. */}
                <div className="mt-3 grid border-t border-slate-200 pt-2" style={{ gridTemplateColumns: `repeat(${flowData.length}, minmax(0, 1fr))` }}>
                  {flowData.map((point) => (
                    <div key={point.month} className="text-center">
                      <p className="text-sm">
                        <Change value={point.net} />
                      </p>
                      <p className="text-phx-xs font-semibold text-slate-400">net</p>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="py-16 text-center text-xs text-slate-500">Pick two months or more to see who came and who went.</p>
            )}
          </Panel>
        </div>
      </div>

      {/* Breakdown */}
      <Panel
        title={`Pharmacies by ${DIMENSION_LABELS[dimension].toLowerCase()}`}
        subtitle="Each pharmacy counted once per row and month, so rows are not added up"
        icon={<Layers className="h-4 w-4" />}
        action={
          <ExportXlsxButton
            columns={exportColumns}
            rows={exportRows}
            title={`Customer Count by ${DIMENSION_LABELS[dimension]}`}
            subtitle={scopeLine}
            sheetName={`By ${DIMENSION_LABELS[dimension]}`}
          />
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="inline-flex flex-wrap border border-slate-900">
            {DIMENSIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setDimension(option)}
                aria-pressed={dimension === option}
                className={`border-r border-slate-200 px-3.5 py-2 text-xs font-black uppercase tracking-wider transition last:border-r-0 ${dimension === option ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-orange-50 hover:text-orange-700"}`}
              >
                {DIMENSION_LABELS[option]}
              </button>
            ))}
          </div>
          <TableSearchInput
            value={query}
            onChange={setQuery}
            onClear={() => setQuery("")}
            placeholder={`Search ${DIMENSION_LABELS[dimension].toLowerCase()}…`}
            className="w-full sm:w-56"
          />
          <span className="text-xs font-bold tabular-nums text-slate-500">{formatNumber(visibleRows.length)} rows</span>
        </div>

        {top.length > 0 ? (
          <div className="mb-5 border-b border-slate-200 pb-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-phx-sm font-black uppercase tracking-[0.16em] text-slate-500">
                Top {top.length} · {latestLabel}
              </p>
              <Key items={[{ label: latestLabel, color: ORANGE }, ...(multiMonth ? [{ label: priorLabel, color: PRIOR }] : [])]} />
            </div>
            <SafeResponsiveContainer minHeight={Math.max(180, top.length * 30 + 24)}>
              <BarChart data={top} layout="vertical" barGap={2} margin={{ top: 0, right: 48, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID} horizontal={false} />
                <XAxis type="number" axisLine={false} tickLine={false} tick={AXIS} allowDecimals={false} tickFormatter={compact} />
                <YAxis type="category" dataKey="name" axisLine={{ stroke: INK }} tickLine={false} tick={{ ...AXIS, fill: "#1E293B" }} width={160} interval={0} />
                <Tooltip content={<CountTooltip />} cursor={{ fill: "#FFF7ED" }} />
                {multiMonth ? <Bar dataKey={priorLabel} fill={PRIOR} barSize={8} isAnimationActive={false} /> : null}
                <Bar dataKey={latestLabel} fill={ORANGE} barSize={10} isAnimationActive={false}>
                  <LabelList dataKey={latestLabel} position="right" formatter={(value: unknown) => formatNumber(Number(value))} style={BAR_LABEL} />
                </Bar>
              </BarChart>
            </SafeResponsiveContainer>
          </div>
        ) : null}

        {/* Desktop: the full table, every number centred */}
        <div className="hidden md:block">
          <table className="w-full table-fixed text-xs">
            <colgroup>
              <col className="w-[44px]" />
              <col className={hasParent ? "w-[20%]" : "w-[28%]"} />
              {hasParent ? <col className="w-[12%]" /> : null}
              {monthsOnShow.map((month) => (
                <col key={month} />
              ))}
              {multiMonth ? <col className="w-[8%]" /> : null}
              {multiMonth ? <col className="w-[8%]" /> : null}
              {multiMonth ? <col className="w-[9%]" /> : null}
            </colgroup>
            <thead>
              <tr className="text-phx-sm font-black uppercase tracking-wider">
                <th className="px-2 py-2.5">#</th>
                <th className="px-2.5 py-2.5">{DIMENSION_LABELS[dimension]}</th>
                {hasParent ? <th className="px-2.5 py-2.5">{parentLabel}</th> : null}
                {monthsOnShow.map((month) => (
                  <th key={month} className="px-2 py-2.5">
                    {monthShort(month)}
                  </th>
                ))}
                {multiMonth ? <th className="px-2 py-2.5">Change</th> : null}
                {multiMonth ? <th className="px-2 py-2.5">Any month</th> : null}
                {multiMonth ? <th className="px-2 py-2.5">Trend</th> : null}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, rowIndex) => {
                const latest = row.perMonth.at(-1) ?? 0;
                return (
                  <tr key={row.key} className="transition-colors even:bg-slate-50/70 hover:bg-orange-50">
                    <td className="px-2 py-2 text-center font-black tabular-nums text-slate-400">{String(rowIndex + 1).padStart(2, "0")}</td>
                    <td className="px-2.5 py-2">
                      <p className="break-words font-black text-slate-900">{row.label}</p>
                      {/* The row's size against the biggest row this month. */}
                      <div aria-hidden="true" className="mt-1 h-[3px] w-full bg-slate-100">
                        <div className="h-full bg-orange-600" style={{ width: `${(latest / latestMax) * 100}%` }} />
                      </div>
                    </td>
                    {hasParent ? <td className="break-words px-2.5 py-2 text-center font-semibold text-slate-600">{row.parent}</td> : null}
                    {row.perMonth.map((count, index) => {
                      const isLatest = index === row.perMonth.length - 1;
                      return (
                        <td
                          key={index}
                          className={`px-2 py-2 text-center tabular-nums ${isLatest ? "bg-orange-50/80 text-[0.82rem] font-black text-slate-900" : "font-semibold text-slate-600"}`}
                        >
                          {formatNumber(count)}
                        </td>
                      );
                    })}
                    {multiMonth ? (
                      <td className="px-2 py-2 text-center">
                        <Change value={row.change} />
                      </td>
                    ) : null}
                    {multiMonth ? <td className="px-2 py-2 text-center font-bold tabular-nums text-slate-800">{formatNumber(row.total)}</td> : null}
                    {multiMonth ? (
                      <td className="px-2 py-1.5">
                        <MicroBars values={row.perMonth} />
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visibleRows.length === 0 ? <p className="py-8 text-center text-xs text-slate-500">No pharmacy bought in this selection.</p> : null}
        </div>

        {/* Mobile: one card per row */}
        <div className="space-y-2 md:hidden">
          {visibleRows.map((row, rowIndex) => {
            const latest = row.perMonth.at(-1) ?? 0;
            return (
              <div key={row.key} className="relative border border-slate-200 bg-white p-3 pl-4">
                <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-orange-600" />
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-phx-xs font-black tabular-nums text-slate-400">{String(rowIndex + 1).padStart(2, "0")}</p>
                    <p className="break-words text-sm font-black text-slate-900">{row.label}</p>
                    {row.parent ? <p className="text-xs font-semibold text-slate-500">{row.parent}</p> : null}
                  </div>
                  <div className="text-center">
                    <p className="text-xl font-black tabular-nums leading-none text-slate-900">{formatNumber(latest)}</p>
                    <p className="mt-1 text-xs">
                      <Change value={row.change} />
                    </p>
                  </div>
                </div>
                <div aria-hidden="true" className="mt-2 h-[3px] w-full bg-slate-100">
                  <div className="h-full bg-orange-600" style={{ width: `${(latest / latestMax) * 100}%` }} />
                </div>
                {multiMonth ? (
                  <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-phx-xs">
                    {monthsOnShow.map((month, index) => (
                      <span key={month} className="flex flex-col items-center text-slate-500">
                        <span>{monthShort(month)}</span>
                        <span className={`tabular-nums ${index === monthsOnShow.length - 1 ? "font-black text-slate-900" : "font-bold text-slate-700"}`}>
                          {formatNumber(row.perMonth[index] ?? 0)}
                        </span>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {visibleRows.length === 0 ? <p className="py-8 text-center text-xs text-slate-500">No pharmacy bought in this selection.</p> : null}
        </div>
      </Panel>
    </div>
  );
}
