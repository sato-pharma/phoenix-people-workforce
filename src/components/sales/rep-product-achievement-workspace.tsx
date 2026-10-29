"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Download,
  RotateCcw,
  Search,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";

import {
  PortalEmptyState,
  PortalFilterBar,
  PortalMetricCard,
  PortalPagination,
  PortalSection,
  PortalSegmentedTabs,
} from "@/components/employee-portal/portal-primitives";
import {
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
  phxLabelClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import {
  DEFAULT_REP_ACHIEVEMENT_FILTERS,
  REP_ACHIEVEMENT_ALL,
  achievementBand,
  describeAchievementCell,
  filterRepAchievement,
  focusCells,
  formatRepHireDate,
  gradedValue,
  repAchievementFilterOptions,
  repAchievementQuery,
  sortRepAchievement,
  type AchievementCell,
  type PeriodColumn,
  type RepAchievementData,
  type RepAchievementFilters,
  type RepAchievementRecord,
  type RepAchievementSort,
} from "@/lib/sales/rep-product-achievement";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// REP ACHIEVEMENT BY PRODUCT — the Training Manager's screen. One row per rep, the nine period
// columns beside each rep (Jul Aug Sep Q3 Oct Nov Dec Q4 S2); pick a product and every row reads that
// product, open a row and that rep's products unfold under it. Every filter here is the export's filter:
// the Export link carries them, and the route runs the same `filterRepAchievement`.
//
// Fits the screen at every width (golden rule): `table-fixed` with a colgroup on a wide container,
// cards on a narrow one, never a sideways scroll. Square edges. A cell with no percentage says so in
// words and sinks in any sort — "no target" is never the worst performer.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 40;

const BAND_TEXT = {
  bad: "text-rose-700",
  good: "text-emerald-700",
  warn: "text-amber-700",
} as const;

const BAND_RULE = {
  bad: "border-l-rose-600",
  good: "border-l-emerald-600",
  warn: "border-l-amber-500",
} as const;

function isSummaryColumn(column: PeriodColumn) {
  return column.kind !== "month";
}

function columnIsToDate(column: PeriodColumn, currentPeriod: string) {
  return isSummaryColumn(column) && column.months.some((month) => month > currentPeriod);
}

function CellValue({ cell, strong }: { cell: AchievementCell | undefined; strong?: boolean }) {
  if (!cell) return <span className="text-xs font-semibold text-slate-300">—</span>;
  const words = describeAchievementCell(cell);
  if (cell.state === "graded" && cell.value != null) {
    const band = achievementBand(cell.value);
    return (
      <span
        className={cn(
          "tabular-nums",
          strong ? "text-base font-black" : "text-sm font-bold",
          band ? BAND_TEXT[band] : "text-slate-700",
        )}
        title={words.long}
      >
        {words.short}
      </span>
    );
  }
  return (
    <span className="text-phx-2xs font-bold break-words uppercase leading-tight tracking-normal text-slate-400" title={words.long}>
      {words.short}
    </span>
  );
}

function SortHead({
  active,
  align = "center",
  children,
  direction,
  onClick,
  shaded,
}: {
  active: boolean;
  align?: "left" | "center";
  children: React.ReactNode;
  direction: "asc" | "desc";
  onClick: () => void;
  shaded?: boolean;
}) {
  const Arrow = direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn(
        "border-b border-slate-200 px-2 py-2.5 align-bottom",
        shaded ? "bg-slate-100" : "bg-slate-50",
        align === "center" ? "text-center" : "text-left",
      )}
      scope="col"
    >
      <button
        className={cn(
          // The portal shell paints every table head black with light ink (globals.css,
          // `.employee-portal-shell thead th`), so the sort label is light too: dark ink went black on black.
          "inline-flex items-center gap-1 text-phx-2xs font-black uppercase tracking-[0.14em] transition hover:text-white",
          active ? "text-white" : "text-slate-300",
        )}
        onClick={onClick}
        type="button"
      >
        {children}
        <Arrow className={cn("h-3 w-3 shrink-0", active ? "opacity-100" : "opacity-0")} />
      </button>
    </th>
  );
}

function filtersAreDefault(filters: RepAchievementFilters) {
  return (Object.keys(DEFAULT_REP_ACHIEVEMENT_FILTERS) as Array<keyof RepAchievementFilters>).every(
    (key) => filters[key] === DEFAULT_REP_ACHIEVEMENT_FILTERS[key],
  );
}

export function RepProductAchievementWorkspace({
  canExport,
  data,
  initialFilters,
}: {
  canExport: boolean;
  data: RepAchievementData;
  initialFilters: RepAchievementFilters;
}) {
  const router = useRouter();
  const [filters, setFilters] = useState<RepAchievementFilters>(initialFilters);
  const lastColumn = data.columns.length - 1;
  const [sort, setSort] = useState<RepAchievementSort>({ column: lastColumn, direction: "desc" });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(PAGE_SIZE);

  const options = useMemo(() => repAchievementFilterOptions(data.records, filters.line), [data.records, filters.line]);
  const filtered = useMemo(() => filterRepAchievement(data.records, filters), [data.records, filters]);
  const sorted = useMemo(() => sortRepAchievement(filtered, filters.product, sort), [filtered, filters.product, sort]);
  const visible = sorted.slice(0, shown);
  const productName =
    filters.product === REP_ACHIEVEMENT_ALL
      ? null
      : options.products.find((product) => product.value === filters.product)?.label ?? null;

  const counts = useMemo(() => {
    let good = 0;
    let warn = 0;
    let bad = 0;
    let ungraded = 0;
    for (const record of filtered) {
      const band = achievementBand(gradedValue(focusCells(record, filters.product)[lastColumn]));
      if (band === "good") good += 1;
      else if (band === "warn") warn += 1;
      else if (band === "bad") bad += 1;
      else ungraded += 1;
    }
    return { bad, good, ungraded, warn };
  }, [filtered, filters.product, lastColumn]);

  const semesterColumn = data.columns[lastColumn];
  const exportHref = `/api/employee-portals/rep-achievement/export?${repAchievementQuery(data.semester, filters)}`;

  function update<K extends keyof RepAchievementFilters>(key: K, value: RepAchievementFilters[K]) {
    setShown(PAGE_SIZE);
    setFilters((current) => {
      const next = { ...current, [key]: value };
      // A line change can strand a region, manager or product the new line does not have.
      if (key === "line") {
        const nextOptions = repAchievementFilterOptions(data.records, String(value));
        if (!nextOptions.regions.includes(next.region)) next.region = REP_ACHIEVEMENT_ALL;
        if (!nextOptions.managers.includes(next.manager)) next.manager = REP_ACHIEVEMENT_ALL;
        if (!nextOptions.products.some((product) => product.value === next.product)) next.product = REP_ACHIEVEMENT_ALL;
      }
      return next;
    });
  }

  function sortBy(column: RepAchievementSort["column"]) {
    setSort((current) =>
      current.column === column
        ? ({ column, direction: current.direction === "asc" ? "desc" : "asc" } as RepAchievementSort)
        : ({ column, direction: column === "name" ? "asc" : "desc" } as RepAchievementSort),
    );
  }

  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const allOpen = visible.length > 0 && visible.every((record) => expanded.has(record.key));

  function changeSemester(semester: string) {
    router.push(`?${repAchievementQuery(semester, filters)}`);
  }

  const publishedNote = data.lines
    .map((line) => {
      const months = data.publishedMonths[line.value] ?? [];
      const labels = data.columns
        .filter((column) => column.kind === "month" && months.includes(column.id))
        .map((column) => column.label);
      return `${line.label}: ${labels.length ? labels.join(", ") : "none yet"}`;
    })
    .join(" · ");

  return (
    <div className="space-y-4">
      <PortalFilterBar
        countLabel={`${filtered.length} of ${data.records.length} reps`}
        title="Filters"
      >
        <div className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] lg:items-end">
            <label className="block min-w-0">
              <span className={phxLabelClassName}>Semester</span>
              <select
                className={phxSelectClassName}
                onChange={(event) => changeSemester(event.target.value)}
                value={data.semester}
              >
                {data.semesters.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="min-w-0">
              <span className={phxLabelClassName}>Line</span>
              <PortalSegmentedTabs className="grid grid-cols-2 sm:grid-cols-4">
                {[{ label: "All lines", value: REP_ACHIEVEMENT_ALL }, ...data.lines].map((line) => {
                  const active = filters.line === line.value;
                  return (
                    <button
                      aria-pressed={active}
                      className={cn(
                        "min-h-9 min-w-0 px-3 py-1.5 text-sm font-bold transition",
                        active
                          ? "bg-white text-slate-950 shadow-[0_1px_3px_rgba(15,23,42,0.12)]"
                          : "text-slate-500 hover:text-slate-800",
                      )}
                      key={line.value}
                      onClick={() => update("line", line.value)}
                      type="button"
                    >
                      {line.label}
                    </button>
                  );
                })}
              </PortalSegmentedTabs>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <label className="block min-w-0">
              <span className={phxLabelClassName}>Product</span>
              <select
                className={phxSelectClassName}
                onChange={(event) => update("product", event.target.value)}
                value={filters.product}
              >
                <option value={REP_ACHIEVEMENT_ALL}>All products together</option>
                {options.products.map((product) => (
                  <option key={product.value} value={product.value}>
                    {product.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block min-w-0">
              <span className={phxLabelClassName}>Region</span>
              <select
                className={phxSelectClassName}
                onChange={(event) => update("region", event.target.value)}
                value={filters.region}
              >
                <option value={REP_ACHIEVEMENT_ALL}>Every region</option>
                {options.regions.map((region) => (
                  <option key={region} value={region}>
                    {region}
                  </option>
                ))}
              </select>
            </label>
            <label className="block min-w-0">
              <span className={phxLabelClassName}>Manager</span>
              <select
                className={phxSelectClassName}
                onChange={(event) => update("manager", event.target.value)}
                value={filters.manager}
              >
                <option value={REP_ACHIEVEMENT_ALL}>Every manager</option>
                {options.managers.map((manager) => (
                  <option key={manager} value={manager}>
                    {manager}
                  </option>
                ))}
              </select>
            </label>
            <label className="block min-w-0">
              <span className={phxLabelClassName}>Status</span>
              <select
                className={phxSelectClassName}
                onChange={(event) => update("status", event.target.value as RepAchievementFilters["status"])}
                value={filters.status}
              >
                <option value="all">Active and left</option>
                <option value="active">Active only</option>
                <option value="left">Left only</option>
              </select>
            </label>
            <label className="block min-w-0">
              <span className={phxLabelClassName}>Search</span>
              <span className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  className={cn(phxFieldClassName, "pl-9")}
                  maxLength={120}
                  onChange={(event) => update("search", event.target.value)}
                  placeholder="Rep, area or manager"
                  type="search"
                  value={filters.search}
                />
              </span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canExport ? (
              <a className={phxButtonPrimaryClassName} download href={exportHref}>
                <Download className="h-4 w-4" />
                Export to Excel
              </a>
            ) : null}
            <button
              className={phxButtonGhostClassName}
              disabled={filtersAreDefault(filters)}
              onClick={() => {
                setShown(PAGE_SIZE);
                setFilters(DEFAULT_REP_ACHIEVEMENT_FILTERS);
              }}
              type="button"
            >
              <RotateCcw className="h-4 w-4" />
              Clear filters
            </button>
          </div>
        </div>
      </PortalFilterBar>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <PortalMetricCard accent="slate" icon={Users} label="Reps shown" note={productName ?? "All products together"} value={filtered.length} />
        <PortalMetricCard
          accent="emerald"
          icon={TrendingUp}
          label={`${semesterColumn?.label ?? "Semester"} at 100% or more`}
          note="On target or above"
          value={counts.good}
        />
        <PortalMetricCard accent="amber" icon={Target} label={`${semesterColumn?.label ?? "Semester"} 80% to 99%`} note="Close to target" value={counts.warn} />
        <PortalMetricCard
          accent="rose"
          icon={TrendingDown}
          label={`${semesterColumn?.label ?? "Semester"} under 80%`}
          note={counts.ungraded ? `${counts.ungraded} with no target yet` : "Below target"}
          value={counts.bad}
        />
      </div>

      <PortalSection
        actions={
          visible.length ? (
            <button
              className={phxButtonGhostClassName}
              onClick={() =>
                setExpanded(allOpen ? new Set() : new Set(visible.map((record) => record.key)))
              }
              type="button"
            >
              {allOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              {allOpen ? "Close all reps" : "Open all reps"}
            </button>
          ) : null
        }
        description={
          <>
            Sales ÷ target from the published Monthly Closing. A quarter and the semester are summed, then divided
            once. Published so far: {publishedNote}.
          </>
        }
        eyebrow={data.semesters.find((option) => option.value === data.semester)?.label}
        title={productName ? `${productName} by rep` : "Every product together, by rep"}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-100 px-4 py-2.5 text-xs font-semibold text-slate-500 sm:px-5">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 bg-emerald-600" /> 100% or more
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 bg-amber-500" /> 80% to 99%
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 bg-rose-600" /> Under 80%
          </span>
          <span>“No target” and “Not published” are never counted as 0%.</span>
        </div>

        {sorted.length === 0 ? (
          <PortalEmptyState
            message={
              data.records.length === 0
                ? "No published sales and targets for this semester yet."
                : "No rep matches these filters. Clear a filter to see more."
            }
            title="No reps to show"
          />
        ) : (
          <div className="@container">
            {/* Desktop and wide tablet: the table. */}
            <div className="hidden @min-[880px]:block">
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <colgroup>
                  <col className="w-[28%]" />
                  {data.columns.map((column) => (
                    <col className="w-[8%]" key={column.id} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <SortHead
                      active={sort.column === "name"}
                      align="left"
                      direction={sort.direction}
                      onClick={() => sortBy("name")}
                    >
                      Rep
                    </SortHead>
                    {data.columns.map((column, index) => (
                      <SortHead
                        active={sort.column === index}
                        direction={sort.direction}
                        key={column.id}
                        onClick={() => sortBy(index)}
                        shaded={isSummaryColumn(column)}
                      >
                        <span className="flex flex-col items-center leading-tight">
                          <span>{column.label}</span>
                          {columnIsToDate(column, data.currentPeriod) ? (
                            <span className="text-[10px] font-bold normal-case tracking-normal text-slate-400">to date</span>
                          ) : null}
                        </span>
                      </SortHead>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((record) => (
                    <DesktopRepRows
                      columns={data.columns}
                      expanded={expanded.has(record.key)}
                      key={record.key}
                      onToggle={() => toggle(record.key)}
                      productCode={filters.product}
                      record={record}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Phone and narrow tablet: one card per rep. */}
            <div className="divide-y divide-slate-100 @min-[880px]:hidden">
              {visible.map((record) => (
                <MobileRepCard
                  columns={data.columns}
                  currentPeriod={data.currentPeriod}
                  expanded={expanded.has(record.key)}
                  key={record.key}
                  onToggle={() => toggle(record.key)}
                  productCode={filters.product}
                  record={record}
                />
              ))}
            </div>
          </div>
        )}

        {sorted.length > 0 ? (
          <PortalPagination label={`Showing ${visible.length} of ${sorted.length} reps`}>
            {visible.length < sorted.length ? (
              <button className={phxButtonGhostClassName} onClick={() => setShown((count) => count + PAGE_SIZE)} type="button">
                Show {Math.min(PAGE_SIZE, sorted.length - visible.length)} more
              </button>
            ) : null}
          </PortalPagination>
        ) : null}
      </PortalSection>
    </div>
  );
}

function repMeta(record: RepAchievementRecord) {
  const hired = formatRepHireDate(record.hireDate);
  return [record.lineName, record.areaName, record.managerName ? `Manager: ${record.managerName}` : "", hired ? `Hired ${hired}` : ""]
    .filter(Boolean)
    .join(" · ");
}

function DesktopRepRows({
  columns,
  expanded,
  onToggle,
  productCode,
  record,
}: {
  columns: PeriodColumn[];
  expanded: boolean;
  onToggle: () => void;
  productCode: string;
  record: RepAchievementRecord;
}) {
  const cells = focusCells(record, productCode);
  const band = achievementBand(gradedValue(cells[columns.length - 1]));
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <tr className={cn("border-b border-slate-100 transition hover:bg-orange-50/40", expanded && "bg-slate-50/60")}>
        <td className={cn("border-l-[3px] px-3 py-2.5", band ? BAND_RULE[band] : "border-l-slate-200")}>
          <button aria-expanded={expanded} className="flex w-full min-w-0 items-start gap-2 text-left" onClick={onToggle} type="button">
            <Chevron className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="break-words font-black text-slate-950">{record.name}</span>
                {record.left ? (
                  <span className="border border-slate-300 px-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-500">
                    Left
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block break-words text-xs font-semibold text-slate-500">{repMeta(record)}</span>
            </span>
          </button>
        </td>
        {columns.map((column, index) => (
          <td
            className={cn("px-1 py-2.5 text-center", isSummaryColumn(column) && "bg-slate-50")}
            key={column.id}
          >
            <CellValue cell={cells[index]} strong={isSummaryColumn(column)} />
          </td>
        ))}
      </tr>
      {expanded
        ? record.products.map((product) => (
            <tr className="border-b border-slate-100 bg-white" key={product.productCode}>
              <td className="border-l-[3px] border-l-slate-100 py-2 pl-9 pr-3">
                <span
                  className={cn(
                    "break-words text-xs font-bold",
                    product.productCode === productCode ? "text-orange-700" : "text-slate-700",
                  )}
                >
                  {product.productName}
                </span>
              </td>
              {columns.map((column, index) => (
                <td className={cn("px-1 py-2 text-center", isSummaryColumn(column) && "bg-slate-50")} key={column.id}>
                  <CellValue cell={product.cells[index]} />
                </td>
              ))}
            </tr>
          ))
        : null}
    </>
  );
}

function PeriodGrid({
  cells,
  columns,
  currentPeriod,
  dense,
}: {
  cells: AchievementCell[];
  columns: PeriodColumn[];
  currentPeriod: string;
  dense?: boolean;
}) {
  return (
    <dl className="grid grid-cols-4 gap-px border border-slate-200 bg-slate-200">
      {columns.map((column, index) => {
        const isSemester = column.kind === "semester";
        return (
          <div
            className={cn(
              "flex min-w-0 flex-col items-center justify-center px-1 text-center",
              dense ? "py-1.5" : "py-2",
              isSummaryColumn(column) ? "bg-slate-50" : "bg-white",
              isSemester && "col-span-4 flex-row gap-3",
            )}
            key={column.id}
          >
            <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
              {column.label}
              {columnIsToDate(column, currentPeriod) ? " to date" : ""}
            </dt>
            <dd className="min-w-0">
              <CellValue cell={cells[index]} strong={isSemester && !dense} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function MobileRepCard({
  columns,
  currentPeriod,
  expanded,
  onToggle,
  productCode,
  record,
}: {
  columns: PeriodColumn[];
  currentPeriod: string;
  expanded: boolean;
  onToggle: () => void;
  productCode: string;
  record: RepAchievementRecord;
}) {
  const cells = focusCells(record, productCode);
  const band = achievementBand(gradedValue(cells[columns.length - 1]));
  return (
    <article className={cn("border-l-[3px] bg-white px-4 py-3.5", band ? BAND_RULE[band] : "border-l-slate-200")}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-1.5 break-words text-sm font-black text-slate-950">
            {record.name}
            {record.left ? (
              <span className="border border-slate-300 px-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-500">
                Left
              </span>
            ) : null}
          </h3>
          <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{repMeta(record)}</p>
        </div>
      </div>
      <div className="mt-3">
        <PeriodGrid cells={cells} columns={columns} currentPeriod={currentPeriod} />
      </div>
      {record.products.length ? (
        <button
          aria-expanded={expanded}
          className="mt-3 inline-flex items-center gap-1 text-xs font-black uppercase tracking-[0.12em] text-orange-700"
          onClick={onToggle}
          type="button"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {expanded ? "Hide products" : `${record.products.length} product${record.products.length === 1 ? "" : "s"}`}
        </button>
      ) : null}
      {expanded ? (
        <div className="mt-3 space-y-3">
          {record.products.map((product) => (
            <div key={product.productCode}>
              <p className="mb-1 break-words text-xs font-black text-slate-700">{product.productName}</p>
              <PeriodGrid cells={product.cells} columns={columns} currentPeriod={currentPeriod} dense />
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}
