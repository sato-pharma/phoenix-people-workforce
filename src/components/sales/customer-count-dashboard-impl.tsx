"use client";

// THE CUSTOMER COUNT DASHBOARD — how many pharmacies bought, month by month, cut by line, product,
// region, area, brick and medical rep. One component, two doors: the admin page and a manager's
// portal page, each passing its own endpoint (the server decides the scope; this only draws it).
//
// Every number is a count of DISTINCT pharmacies (customer-count-dashboard.ts): a total is never the
// sum of the rows above it, so no total row is drawn and the export adds none.

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
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, Tooltip, XAxis, YAxis } from "recharts";

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

const ORANGE = "#F97316";
const INK = "#0F172A";
const GAIN = "#059669";
const LOSS = "#E11D48";
const GRID = "#F1F5F9";
const AXIS = { fontSize: 10, fontWeight: 700, fill: "#64748B" } as const;

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

function Tile({
  label,
  value,
  sub,
  icon,
  accent = false,
  change,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  accent?: boolean;
  change?: number | null;
}) {
  return (
    <div className="relative min-w-0 border border-slate-200 bg-white p-4">
      <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-[3px] ${accent ? "bg-orange-500" : "bg-slate-900"}`} />
      <div className="flex items-start justify-between gap-2">
        <p className="text-phx-sm font-black uppercase tracking-[0.14em] text-slate-500">{label}</p>
        <span className={accent ? "text-orange-500" : "text-slate-300"}>{icon}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-2">
        <span className="text-2xl font-black tabular-nums leading-none text-slate-900">{value}</span>
        {change !== undefined ? (
          <span className="text-xs">
            <Change value={change} />
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 text-phx-xs font-semibold text-slate-500">{sub}</p>
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
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="text-orange-500">{icon}</span>
          <div className="min-w-0">
            <h3 className="text-sm font-black tracking-tight text-slate-900">{title}</h3>
            <p className="text-xs text-slate-500">{subtitle}</p>
          </div>
        </div>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function CountTooltip({ active, payload, label }: { active?: boolean; payload?: Array<Record<string, unknown>>; label?: unknown }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="border border-slate-200 bg-white p-3">
      <p className="mb-1 text-phx-sm font-black uppercase tracking-wider text-slate-500">{String(label ?? "")}</p>
      {payload.map((entry, index) => (
        <div key={index} className="flex items-center justify-between gap-4 text-phx-xs">
          <span className="flex items-center gap-2 font-bold text-slate-600">
            <span className="h-2 w-2" style={{ backgroundColor: String(entry.color ?? "#94A3B8") }} />
            {String(entry.name ?? "")}
          </span>
          <span className="font-black tabular-nums text-slate-900">{formatNumber(Number(entry.value ?? 0))}</span>
        </div>
      ))}
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
    Lost: point.lost ?? 0,
    "Products per pharmacy": Number(point.productsPerPharmacy.toFixed(2)),
  }));
  const top = visibleRows.slice(0, 12).map((row) => ({
    name: row.label,
    [latestLabel]: row.perMonth.at(-1) ?? 0,
    ...(multiMonth ? { [priorLabel]: row.perMonth.at(-2) ?? 0 } : {}),
  }));
  const hasParent = dimension === "product" || dimension === "area" || dimension === "brick";
  const parentLabel = dimension === "product" ? "Line" : dimension === "area" ? "Region" : "Area";

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
        <span className="ml-auto inline-flex items-center gap-2 text-xs font-semibold text-slate-500">
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
          accent
          label="Pharmacies buying"
          icon={<Store className="h-4 w-4" />}
          value={formatNumber(summary.latest)}
          change={summary.previous == null ? undefined : summary.latest - summary.previous}
          sub={summary.previousMonth ? `${monthLong(summary.latestMonth)}, against ${formatNumber(summary.previous ?? 0)} in ${monthShort(summary.previousMonth)}` : monthLong(summary.latestMonth)}
        />
        <Tile
          label="Gained"
          icon={<UserPlus className="h-4 w-4" />}
          value={summary.gained == null ? "—" : formatNumber(summary.gained)}
          sub={summary.previousMonth ? `bought in ${monthShort(summary.latestMonth)}, not in ${monthShort(summary.previousMonth)}` : "needs two months"}
        />
        <Tile
          label="Lost"
          icon={<UserMinus className="h-4 w-4" />}
          value={summary.lost == null ? "—" : formatNumber(summary.lost)}
          sub={summary.previousMonth ? `bought in ${monthShort(summary.previousMonth)}, not in ${monthShort(summary.latestMonth)}` : "needs two months"}
        />
        <Tile
          label="Reached"
          icon={<Users className="h-4 w-4" />}
          value={formatNumber(summary.reached)}
          sub={multiMonth ? `bought in any of the ${monthsOnShow.length} months` : "bought this month"}
        />
        <Tile
          label="Every month"
          icon={<Repeat className="h-4 w-4" />}
          value={formatNumber(summary.everyMonth)}
          sub={multiMonth ? `bought in all ${monthsOnShow.length} months` : "bought this month"}
        />
        <Tile
          label="Products each"
          icon={<Boxes className="h-4 w-4" />}
          value={summary.productsPerPharmacy.toFixed(1)}
          sub={`average per buying pharmacy, ${monthShort(summary.latestMonth)}`}
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
            <SafeResponsiveContainer minHeight={280}>
              <ComposedChart data={trendData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="month" axisLine={false} tickLine={false} tick={AXIS} />
                <YAxis yAxisId="count" axisLine={false} tickLine={false} tick={AXIS} width={44} allowDecimals={false} />
                <YAxis yAxisId="depth" orientation="right" axisLine={false} tickLine={false} tick={AXIS} width={32} />
                <Tooltip content={<CountTooltip />} cursor={{ fill: "#F8FAFC" }} />
                <Legend wrapperStyle={{ fontSize: 11, fontWeight: 700 }} />
                <Bar yAxisId="count" dataKey="Pharmacies" fill={ORANGE} barSize={28} />
                <Line yAxisId="depth" type="monotone" dataKey="Products per pharmacy" stroke={INK} strokeWidth={2} dot={{ r: 3, fill: INK }} />
              </ComposedChart>
            </SafeResponsiveContainer>
          </Panel>
        </div>
        <div className="min-w-0 xl:col-span-2">
          <Panel title="Gained and lost" subtitle="Against the month before" icon={<Repeat className="h-4 w-4" />}>
            {multiMonth ? (
              <SafeResponsiveContainer minHeight={280}>
                <BarChart data={trendData.slice(1)} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="month" axisLine={false} tickLine={false} tick={AXIS} />
                  <YAxis axisLine={false} tickLine={false} tick={AXIS} width={40} allowDecimals={false} />
                  <Tooltip content={<CountTooltip />} cursor={{ fill: "#F8FAFC" }} />
                  <Legend wrapperStyle={{ fontSize: 11, fontWeight: 700 }} />
                  <Bar dataKey="Gained" fill={GAIN} barSize={14} />
                  <Bar dataKey="Lost" fill={LOSS} barSize={14} />
                </BarChart>
              </SafeResponsiveContainer>
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
          <div className="inline-flex flex-wrap border border-slate-200">
            {DIMENSIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setDimension(option)}
                className={`px-3 py-1.5 text-xs font-black transition ${dimension === option ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:text-orange-600"}`}
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
          <span className="text-xs font-semibold text-slate-500">{formatNumber(visibleRows.length)} rows</span>
        </div>

        {top.length > 0 ? (
          <div className="mb-4 border-b border-slate-100 pb-4">
            <SafeResponsiveContainer minHeight={Math.max(180, top.length * 26 + 40)}>
              <BarChart data={top} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID} horizontal={false} />
                <XAxis type="number" axisLine={false} tickLine={false} tick={AXIS} allowDecimals={false} />
                <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} tick={AXIS} width={150} interval={0} />
                <Tooltip content={<CountTooltip />} cursor={{ fill: "#F8FAFC" }} />
                <Legend wrapperStyle={{ fontSize: 11, fontWeight: 700 }} />
                {multiMonth ? <Bar dataKey={priorLabel} fill="#CBD5E1" barSize={9} /> : null}
                <Bar dataKey={latestLabel} fill={ORANGE} barSize={9} />
              </BarChart>
            </SafeResponsiveContainer>
          </div>
        ) : null}

        {/* Desktop: the full table */}
        <div className="hidden md:block">
          <table className="w-full table-fixed text-xs">
            <colgroup>
              <col className={hasParent ? "w-[22%]" : "w-[30%]"} />
              {hasParent ? <col className="w-[14%]" /> : null}
              {monthsOnShow.map((month) => (
                <col key={month} />
              ))}
              {multiMonth ? <col className="w-[8%]" /> : null}
              {multiMonth ? <col className="w-[9%]" /> : null}
            </colgroup>
            <thead>
              <tr className="border-b-2 border-slate-900 text-left text-phx-sm font-black uppercase tracking-wider text-slate-600">
                <th className="py-2 pr-2">{DIMENSION_LABELS[dimension]}</th>
                {hasParent ? <th className="py-2 pr-2">{parentLabel}</th> : null}
                {monthsOnShow.map((month) => (
                  <th key={month} className="py-2 pr-2 text-right">
                    {monthShort(month)}
                  </th>
                ))}
                {multiMonth ? <th className="py-2 pr-2 text-right">Change</th> : null}
                {multiMonth ? <th className="py-2 text-right">Any month</th> : null}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.key} className="border-b border-slate-100 even:bg-slate-50/60">
                  <td className="break-words py-1.5 pr-2 font-bold text-slate-900">{row.label}</td>
                  {hasParent ? <td className="break-words py-1.5 pr-2 text-slate-600">{row.parent}</td> : null}
                  {row.perMonth.map((count, index) => (
                    <td
                      key={index}
                      className={`py-1.5 pr-2 text-right tabular-nums ${index === row.perMonth.length - 1 ? "font-black text-slate-900" : "text-slate-700"}`}
                    >
                      {formatNumber(count)}
                    </td>
                  ))}
                  {multiMonth ? (
                    <td className="py-1.5 pr-2 text-right">
                      <Change value={row.change} />
                    </td>
                  ) : null}
                  {multiMonth ? <td className="py-1.5 text-right font-bold tabular-nums text-slate-700">{formatNumber(row.total)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
          {visibleRows.length === 0 ? <p className="py-8 text-center text-xs text-slate-500">No pharmacy bought in this selection.</p> : null}
        </div>

        {/* Mobile: one card per row */}
        <div className="space-y-2 md:hidden">
          {visibleRows.map((row) => (
            <div key={row.key} className="border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-black text-slate-900">{row.label}</p>
                  {row.parent ? <p className="text-xs text-slate-500">{row.parent}</p> : null}
                </div>
                <div className="text-right">
                  <p className="text-lg font-black tabular-nums leading-none text-slate-900">{formatNumber(row.perMonth.at(-1) ?? 0)}</p>
                  <p className="mt-1 text-xs">
                    <Change value={row.change} />
                  </p>
                </div>
              </div>
              {multiMonth ? (
                <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-phx-xs">
                  {monthsOnShow.map((month, index) => (
                    <span key={month} className="flex justify-between gap-1 text-slate-600">
                      <span>{monthShort(month)}</span>
                      <span className="font-bold tabular-nums text-slate-900">{formatNumber(row.perMonth[index] ?? 0)}</span>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          {visibleRows.length === 0 ? <p className="py-8 text-center text-xs text-slate-500">No pharmacy bought in this selection.</p> : null}
        </div>
      </Panel>
    </div>
  );
}
