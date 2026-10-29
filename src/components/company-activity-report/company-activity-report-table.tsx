"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Download,
  Filter,
  Loader2,
  SlidersHorizontal,
  X,
} from "lucide-react";

import { MultiSelectFilter, type MultiSelectFilterOption } from "@/components/ui/multi-select-filter";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";
import {
  companyActivityFilterParams,
  countActiveCompanyActivityFilters,
  describeCompanyActivityFilterList,
  COMPANY_ACTIVITY_REPORT_APPLIED_PARAM,
  NO_COMPANY_ACTIVITY_REPORT_FILTERS,
  type CompanyActivityFilterChip,
} from "@/lib/company-activity-report/filters";
// VALUES stay out of this client component when a module reaches the database — TYPE ONLY imports
// for anything that isn't a leaf pure-JS module, same discipline company-vacation-report-table.tsx
// documents for its own sibling report.
import type { CompanyActivityFilterOptions } from "@/lib/company-activity-report/options";
import {
  companyActivityReportRangeParams,
  COMPANY_ACTIVITY_REPORT_EARLIEST_DATE,
} from "@/lib/company-activity-report/range";
import type { CompanyActivityEmployeeSummary, CompanyActivityFilters, CompanyActivityReport } from "@/lib/company-activity-report/types";
import {
  phxLabelTextClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Constants ────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

const PAGE_SIZE = 50;

/** Same presets, same labels, same arithmetic as the Company Vacation Report's table — the two
 * reporting screens must not disagree about what "this quarter" covers. */
const DATE_PRESETS = [
  { label: "This month", value: "this_month" },
  { label: "Last month", value: "last_month" },
  { label: "This quarter", value: "this_quarter" },
  { label: "This year", value: "this_year" },
] as const;

type DatePreset = (typeof DATE_PRESETS)[number]["value"];

const selectClass  = phxSelectClassName;

const labelClass = phxLabelTextClassName;

type SortDirection = "asc" | "desc";
type SortKey =
  | "employee"
  | "workingDays"
  | "officePresent"
  | "crmVisits"
  | "campaignVisits"
  | "leaveApproved"
  | "noEntry"
  | "conflict";

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Helpers ──────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function isoDay(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Day 0 of the following month is the last day of this one, which is how February and the 30/31
 * split get handled without a table of month lengths. */
function computeDatePreset(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  switch (preset) {
    case "this_month":
      return { from: `${year}-${pad(month + 1)}-01`, to: isoDay(new Date(year, month + 1, 0)) };
    case "last_month":
      return { from: isoDay(new Date(year, month - 1, 1)), to: isoDay(new Date(year, month, 0)) };
    case "this_quarter": {
      const quarterStart = Math.floor(month / 3) * 3;
      return { from: `${year}-${pad(quarterStart + 1)}-01`, to: isoDay(new Date(year, quarterStart + 3, 0)) };
    }
    case "this_year":
      return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
}

// DATE-ONLY (a report window bound, e.g. "2026-08-23"), which `new Date` parses as UTC midnight. UTC
// here is CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset. Not
// an instant — do not "fix" this one to Cairo.
function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function toOptionList(values: string[]): MultiSelectFilterOption[] {
  return values.map((value) => ({ code: value, label: value }));
}

function orgLine(row: CompanyActivityEmployeeSummary): string {
  return [row.lineName, row.teamName, row.areaName, row.regionName].filter(Boolean).join(" · ") || "—";
}

function compareRows(
  left: CompanyActivityEmployeeSummary,
  right: CompanyActivityEmployeeSummary,
  key: SortKey,
  direction: SortDirection,
) {
  const factor = direction === "asc" ? 1 : -1;
  switch (key) {
    case "employee":
      return left.employeeName.localeCompare(right.employeeName, undefined, { sensitivity: "base" }) * factor;
    case "workingDays":
      return (left.workingDays - right.workingDays) * factor;
    case "officePresent":
      return (left.officePresentDays - right.officePresentDays) * factor;
    case "crmVisits":
      return (left.totalCrmVisits - right.totalCrmVisits) * factor;
    case "campaignVisits":
      return (left.campaignVisits - right.campaignVisits) * factor;
    case "leaveApproved":
      return (left.leaveApprovedDays - right.leaveApprovedDays) * factor;
    case "noEntry":
      return (left.noEntryDays - right.noEntryDays) * factor;
    case "conflict":
      return (left.conflictDays - right.conflictDays) * factor;
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Badges ───────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

const badgeBase = "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-phx-xs";

/** Zero renders as a plain muted number everywhere — a badge on every all-zero cell would drown
 * out the rows that actually need attention. */
function CountBadge({ tone, value }: { tone: "accent" | "danger" | "neutral" | "warn"; value: number }) {
  if (value === 0) return <span className="text-phx-xs font-semibold text-slate-400">0</span>;
  const toneClass = {
    accent: "border-orange-200 bg-orange-50 text-orange-700",
    danger: "border-rose-200 bg-rose-50 text-rose-700",
    neutral: "border-slate-200 bg-slate-100 text-slate-700",
    warn: "border-amber-200 bg-amber-50 text-amber-700",
  }[tone];
  return <span className={cn(badgeBase, "font-bold", toneClass)}>{value}</span>;
}

/** Surfaced only when it is actually informative — most employees have both channels, so a Yes/Yes
 * badge on every row would be pure noise. This is what tells "nothing happened" apart from "the
 * system cannot see this person at all". */
function NoSignalNote({ row }: { row: CompanyActivityEmployeeSummary }) {
  if (row.hasAttendanceChannel && row.hasCrmChannel) return null;
  const missing = [!row.hasAttendanceChannel && "no device", !row.hasCrmChannel && "no CRM id"].filter(Boolean).join(", ");
  return <p className="mt-0.5 text-phx-2xs font-bold text-amber-600">⚠ {missing}</p>;
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Metric Card ──────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function MetricCard({
  description,
  label,
  tone,
  value,
}: {
  description: string;
  label: string;
  tone: "blue" | "emerald" | "orange" | "rose" | "slate";
  value: number | string;
}) {
  const toneMap = {
    blue: { bg: "bg-sky-50", border: "border-sky-100", label: "text-sky-600", value: "text-sky-900" },
    emerald: { bg: "bg-emerald-50", border: "border-emerald-100", label: "text-emerald-600", value: "text-emerald-900" },
    orange: { bg: "bg-orange-50", border: "border-orange-100", label: "text-orange-600", value: "text-orange-900" },
    rose: { bg: "bg-rose-50", border: "border-rose-100", label: "text-rose-600", value: "text-rose-900" },
    slate: { bg: "bg-slate-50", border: "border-slate-200", label: "text-slate-500", value: "text-slate-900" },
  }[tone];

  return (
    <div className={cn("rounded-sm border p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]", toneMap.border, toneMap.bg)}>
      <p className={cn("text-phx-2xs font-bold uppercase tracking-[0.12em]", toneMap.label)}>{label}</p>
      <p className={cn("mt-1.5 text-[1.75rem] font-extrabold leading-none tracking-[-0.04em]", toneMap.value)}>{value}</p>
      <p className="mt-2 text-phx-xs font-medium leading-4 text-slate-500">{description}</p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Sortable Table Header ────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function SortableHeader({
  active,
  children,
  direction,
  onSort,
  sortKey,
}: {
  active: boolean;
  children: React.ReactNode;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
  sortKey: SortKey;
}) {
  return (
    <th
      className="cursor-pointer select-none border-b border-r border-slate-100 px-3 py-2.5 transition hover:bg-slate-100"
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active ? (
          direction === "asc" ? (
            <ArrowUp className="h-3 w-3 text-orange-500" />
          ) : (
            <ArrowDown className="h-3 w-3 text-orange-500" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 text-slate-300" />
        )}
      </span>
    </th>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Mobile row card ──────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * The admin shell shows full tables on desktop and cards on mobile — the owner's standing rule. A
 * desktop table that merely scrolls sideways is not a mobile data strategy.
 */
function EmployeeSummaryCard({ href, row }: { href: string; row: CompanyActivityEmployeeSummary }) {
  return (
    <Link
      className="block rounded-sm border border-slate-200 bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition hover:border-orange-200"
      href={href}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-phx-md font-bold text-slate-900">{row.employeeName}</p>
          <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">{row.jobTitle ?? "—"}</p>
          <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">{orgLine(row)}</p>
          <NoSignalNote row={row} />
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
      </div>

      <div className="mt-2.5 grid grid-cols-4 gap-2">
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Working days</p>
          <p className="mt-0.5 text-phx-sm font-extrabold text-slate-900">{row.workingDays}</p>
        </div>
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Office</p>
          <p className="mt-0.5 text-phx-sm font-extrabold text-slate-900">{row.officePresentDays}</p>
        </div>
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Visits</p>
          <p className="mt-0.5 text-phx-sm font-extrabold text-slate-900">{row.totalCrmVisits}</p>
        </div>
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-orange-500">Campaign</p>
          <p className="mt-0.5 text-phx-sm font-extrabold text-orange-700">{row.campaignVisits}</p>
          <p className="text-phx-2xs font-medium text-slate-400">
            {row.campaignVisitDays} {row.campaignVisitDays === 1 ? "day" : "days"}
            {row.campaignVisitDays > 0 ? ` · ${(row.campaignVisits / row.campaignVisitDays).toFixed(1)}/day` : ""}
          </p>
        </div>
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Leave</p>
          <p className="mt-0.5 text-phx-sm font-extrabold text-slate-900">{row.leaveApprovedDays}</p>
          <p className="text-phx-2xs font-medium text-slate-400">{row.leavePendingDays} pending</p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-phx-xs font-semibold text-slate-500">
          No entry: <CountBadge tone="danger" value={row.noEntryDays} />
        </span>
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-phx-xs font-semibold text-slate-500">
          Conflict: <CountBadge tone="warn" value={row.conflictDays} />
        </span>
      </div>
    </Link>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Report ───────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

export function CompanyActivityReportTable({
  applied,
  endDate,
  filters,
  options,
  report,
  startDate,
}: {
  /** Whether the reader has pressed Apply. Separates "you have not asked yet" from "your filter
   * matched nothing" — two states that look identical if you only count rows. */
  applied: boolean;
  endDate: string;
  /** Already applied SERVER-side. These are here to re-fill the panel and to name what is on
   * screen — never to narrow `report` a second time. */
  filters: CompanyActivityFilters;
  options: CompanyActivityFilterOptions;
  report: CompanyActivityReport;
  startDate: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startFilterTransition] = useTransition();

  // Draft state is what the reader is BUILDING, not what the screen is showing — reconciled by the
  // page remounting this component whenever the applied query changes (see the `key` it passes), so
  // no effect is needed to re-sync them. setState inside useEffect is a lint error in this repo.
  const [draft, setDraft] = useState<CompanyActivityFilters>(filters);
  const [draftStart, setDraftStart] = useState(startDate);
  const [draftEnd, setDraftEnd] = useState(endDate);
  const [panelOpen, setPanelOpen] = useState(!applied);
  const [sortKey, setSortKey] = useState<SortKey>("employee");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [page, setPage] = useState(0);

  const rows = report.summaries;

  const activeFilterCount = countActiveCompanyActivityFilters(filters);
  const draftFilterCount = countActiveCompanyActivityFilters(draft);
  const appliedChips = useMemo(() => describeCompanyActivityFilterList(filters), [filters]);

  const lineOptions = useMemo(() => toOptionList(options.lineNames), [options.lineNames]);
  const teamOptions = useMemo(() => toOptionList(options.teamNames), [options.teamNames]);
  const areaOptions = useMemo(() => toOptionList(options.areaNames), [options.areaNames]);
  const regionOptions = useMemo(() => toOptionList(options.regionNames), [options.regionNames]);

  const setDraftField = <K extends keyof CompanyActivityFilters>(key: K, value: CompanyActivityFilters[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  /** The one navigation in this component. EVERY filter, the date range included, is a query
   * parameter resolved on the server: narrowing in the browser could only ever hide rows already
   * fetched, so picking a wider date range would silently return nothing at all. */
  const runQuery = (nextFilters: CompanyActivityFilters, nextStart: string, nextEnd: string) => {
    const params = companyActivityReportRangeParams({ endDate: nextEnd, startDate: nextStart });
    for (const [key, value] of companyActivityFilterParams(nextFilters)) params.set(key, value);
    params.set(COMPANY_ACTIVITY_REPORT_APPLIED_PARAM, "1");
    startFilterTransition(() => router.push(`${pathname}?${params.toString()}`, { scroll: false }));
  };

  const applyDraft = () => {
    setPanelOpen(false);
    runQuery(draft, draftStart, draftEnd);
  };

  const applyPreset = (preset: DatePreset) => {
    const { from, to } = computeDatePreset(preset);
    setDraftStart(from);
    setDraftEnd(to);
    runQuery(draft, from, to);
  };

  /** Removing one chip re-runs the report immediately — a chip is a statement about what is on
   * screen, so clicking it has to change the screen, not a form the reader must then submit. A
   * multi-select chip resets both its selection AND its include/exclude mode. */
  const removeFilter = (key: CompanyActivityFilterChip["key"]) => {
    const resets: Record<string, Partial<CompanyActivityFilters>> = {
      areas: { areaMode: NO_COMPANY_ACTIVITY_REPORT_FILTERS.areaMode, areaNames: NO_COMPANY_ACTIVITY_REPORT_FILTERS.areaNames },
      jobTitle: { jobTitle: NO_COMPANY_ACTIVITY_REPORT_FILTERS.jobTitle },
      lines: { lineMode: NO_COMPANY_ACTIVITY_REPORT_FILTERS.lineMode, lineNames: NO_COMPANY_ACTIVITY_REPORT_FILTERS.lineNames },
      query: { query: NO_COMPANY_ACTIVITY_REPORT_FILTERS.query },
      regions: { regionMode: NO_COMPANY_ACTIVITY_REPORT_FILTERS.regionMode, regionNames: NO_COMPANY_ACTIVITY_REPORT_FILTERS.regionNames },
      teams: { teamMode: NO_COMPANY_ACTIVITY_REPORT_FILTERS.teamMode, teamNames: NO_COMPANY_ACTIVITY_REPORT_FILTERS.teamNames },
    };
    const next = { ...filters, ...(resets[key] ?? {}) };
    setDraft(next);
    runQuery(next, startDate, endDate);
  };

  const toggleSort = (key: SortKey) => {
    setPage(0);
    if (key === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection("asc");
  };

  const sortedRows = useMemo(
    () => [...rows].sort((left, right) => compareRows(left, right, sortKey, sortDirection)),
    [rows, sortDirection, sortKey],
  );

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = sortedRows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const totals = useMemo(() => {
    let campaignVisits = 0;
    let officePresentDays = 0;
    let noEntryDays = 0;
    let conflictDays = 0;
    for (const row of rows) {
      campaignVisits += row.campaignVisits;
      officePresentDays += row.officePresentDays;
      noEntryDays += row.noEntryDays;
      conflictDays += row.conflictDays;
    }
    return { campaignVisits, conflictDays, employees: rows.length, noEntryDays, officePresentDays };
  }, [rows]);

  // The export is a plain GET that re-runs the same query server-side, so the whole filter has to
  // ride along in the URL: without it the workbook ships the entire company while the counter beside
  // this link is describing a slice of it.
  const rangeAndFilterParams = useMemo(() => {
    const params = companyActivityReportRangeParams({ endDate, startDate });
    for (const [key, value] of companyActivityFilterParams(filters)) params.set(key, value);
    return params;
  }, [endDate, filters, startDate]);
  const exportHref = `/api/company-activity-report/export?${rangeAndFilterParams.toString()}`;
  const drilldownHref = (hrId: string) => `/admin/company-activity-report/${encodeURIComponent(hrId)}?${rangeAndFilterParams.toString()}`;

  return (
    <div className="space-y-3">
      {/* ═══ Advanced Filters ═════════════════════════════════════════ */}
      <div className="rounded-sm border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <button
            aria-expanded={panelOpen}
            className="flex min-w-0 items-center gap-2 text-left"
            onClick={() => setPanelOpen((value) => !value)}
            type="button"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-orange-500" />
            <span className="whitespace-nowrap text-phx-md font-bold text-slate-800">Advanced Filters</span>
            {activeFilterCount > 0 ? (
              <span className="inline-flex items-center whitespace-nowrap rounded-full border border-phx-warn-line bg-phx-warn-bg px-2 py-0.5 text-phx-2xs font-bold text-phx-warn">
                {activeFilterCount} active
              </span>
            ) : null}
            <ChevronDown
              className={cn("h-3.5 w-3.5 text-slate-400 transition-transform duration-200", panelOpen ? "rotate-180" : "")}
            />
          </button>
          <div className="flex flex-wrap items-center gap-1.5">
            {DATE_PRESETS.map((preset) => (
              <button
                key={preset.value}
                className="inline-flex h-8 items-center whitespace-nowrap rounded-sm border border-slate-200 bg-white px-2.5 text-phx-xs font-bold text-slate-600 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
                onClick={() => applyPreset(preset.value)}
                type="button"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {panelOpen ? (
          <div className="border-t border-slate-100 px-4 py-4">
            <p className={cn(labelClass, "text-orange-600")}>Period</p>
            <div className="mt-2 grid gap-3 xs:grid-cols-2 xl:grid-cols-4">
              <label className="space-y-1.5">
                <span className={labelClass}>From</span>
                <input
                  aria-label="Report start date"
                  className={selectClass}
                  max={draftEnd}
                  min={COMPANY_ACTIVITY_REPORT_EARLIEST_DATE}
                  onChange={(event) => setDraftStart(event.target.value)}
                  type="date"
                  value={draftStart}
                />
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>To</span>
                <input
                  aria-label="Report end date"
                  className={selectClass}
                  min={draftStart}
                  onChange={(event) => setDraftEnd(event.target.value)}
                  type="date"
                  value={draftEnd}
                />
              </label>
            </div>

            <p className={cn(labelClass, "mt-5 text-orange-600")}>Narrow by</p>
            <div className="mt-2 grid gap-3 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
              <MultiSelectFilter
                label="Line"
                mode={draft.lineMode}
                onModeChange={(mode) => setDraftField("lineMode", mode)}
                onSelectedChange={(next) => setDraftField("lineNames", next)}
                options={lineOptions}
                selected={draft.lineNames}
              />
              <MultiSelectFilter
                label="Team"
                mode={draft.teamMode}
                onModeChange={(mode) => setDraftField("teamMode", mode)}
                onSelectedChange={(next) => setDraftField("teamNames", next)}
                options={teamOptions}
                selected={draft.teamNames}
              />
              <MultiSelectFilter
                label="Area"
                mode={draft.areaMode}
                onModeChange={(mode) => setDraftField("areaMode", mode)}
                onSelectedChange={(next) => setDraftField("areaNames", next)}
                options={areaOptions}
                selected={draft.areaNames}
              />
              <MultiSelectFilter
                label="Region"
                mode={draft.regionMode}
                onModeChange={(mode) => setDraftField("regionMode", mode)}
                onSelectedChange={(next) => setDraftField("regionNames", next)}
                options={regionOptions}
                selected={draft.regionNames}
              />
              <label className="space-y-1.5">
                <span className={labelClass}>Job Title</span>
                <SearchableSelect
                  className={selectClass}
                  onChange={(event) => setDraftField("jobTitle", event.target.value)}
                  value={draft.jobTitle}
                >
                  <option value="All">All job titles</option>
                  {options.jobTitles.map((jobTitle) => (
                    <option key={jobTitle} value={jobTitle}>{jobTitle}</option>
                  ))}
                </SearchableSelect>
              </label>
              <label className="space-y-1.5 xs:col-span-2">
                <span className={labelClass}>Search</span>
                <input
                  aria-label="Search employee name or HR ID"
                  className={selectClass}
                  onChange={(event) => setDraftField("query", event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") applyDraft();
                  }}
                  placeholder="Name or HR ID"
                  type="text"
                  value={draft.query}
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              {draftFilterCount > 0 ? (
                <button
                  className="inline-flex h-9 items-center whitespace-nowrap rounded-sm border border-slate-200 bg-white px-3 text-phx-sm font-bold text-slate-600 transition hover:bg-slate-50"
                  onClick={() => setDraft(NO_COMPANY_ACTIVITY_REPORT_FILTERS)}
                  type="button"
                >
                  Clear all
                </button>
              ) : null}
              <button
                className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-sm bg-orange-500 px-4 text-phx-sm font-bold text-white transition hover:bg-orange-600 disabled:cursor-wait disabled:bg-orange-300"
                disabled={pending}
                onClick={applyDraft}
                type="button"
              >
                {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Filter className="h-3 w-3" />}
                {pending ? "Running…" : "Apply Filters"}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {!applied ? (
        /* ═══ Nothing asked for yet ══════════════════════════════════ */
        <div className="rounded-sm border border-dashed border-slate-300 bg-white px-6 py-14 text-center shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-orange-50 text-orange-500">
            <Activity className="h-5 w-5" />
          </div>
          <p className="mt-4 text-base font-extrabold tracking-tight text-slate-900">Nothing loaded yet</p>
          <p className="mx-auto mt-2 max-w-xl text-phx-md font-medium leading-6 text-slate-500">
            Pick a period and any filters above, then press <strong className="font-bold text-slate-700">Apply Filters</strong>.
            Only what you filter on appears here — this report never scans the whole company at once.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {DATE_PRESETS.map((preset) => (
              <button
                key={preset.value}
                className="inline-flex h-9 items-center whitespace-nowrap rounded-sm border border-slate-200 bg-white px-3.5 text-phx-sm font-bold text-slate-700 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
                onClick={() => applyPreset(preset.value)}
                type="button"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* ═══ What this screen is showing ══════════════════════════ */}
          <div className="grid gap-2 xs:grid-cols-2 xl:grid-cols-5">
            <MetricCard description="Distinct people in this result." label="Employees" tone="slate" value={totals.employees} />
            <MetricCard description="Office punches across every employee shown." label="Office Present Days" tone="blue" value={totals.officePresentDays} />
            <MetricCard description="CRM visits logged as Campaign/Prospection." label="Campaign Visits" tone="orange" value={totals.campaignVisits} />
            <MetricCard description="Working days with nothing recorded at all." label="No Entry Days" tone={totals.noEntryDays > 0 ? "rose" : "emerald"} value={totals.noEntryDays} />
            <MetricCard description="Days showing BOTH presence and a leave signal." label="Conflict Days" tone={totals.conflictDays > 0 ? "rose" : "emerald"} value={totals.conflictDays} />
          </div>

          {report.holidayCalendarReachable ? null : (
            <p className="rounded-sm border border-amber-200 bg-amber-50/70 px-4 py-2.5 text-phx-xs font-medium leading-5 text-amber-900">
              <strong className="font-bold">The public holiday calendar could not be read</strong> for part of this range.
              Company and fixed-date public holidays still apply, but the moving Islamic and Coptic holidays — both Eids,
              Islamic New Year, the Prophet&apos;s Birthday and Coptic Easter — are missing, so such a day shows below as an
              ordinary working day.
            </p>
          )}

          {report.unmappedCrmVisitCount != null && report.unmappedCrmVisitCount > 0 ? (
            <p className="rounded-sm border border-amber-200 bg-amber-50/70 px-4 py-2.5 text-phx-xs font-medium leading-5 text-amber-900">
              <strong className="font-bold">{report.unmappedCrmVisitCount} CRM visit(s)</strong> in this date range (company-wide,
              not limited to what is shown below) have no resolved employee identity at all — a blind spot in CRM attribution,
              not necessarily related to anyone in this filter.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-slate-200 bg-white px-4 py-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center whitespace-nowrap rounded-sm border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-xs font-bold text-slate-700">
                {formatDate(startDate)} &rarr; {formatDate(endDate)}
              </span>
              {appliedChips.length === 0 ? (
                <span className="whitespace-nowrap text-phx-xs font-semibold text-slate-400">Everyone in this period</span>
              ) : (
                appliedChips.map((chip) => (
                  <button
                    key={chip.key}
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-orange-200 bg-orange-50 px-2.5 py-1 text-phx-xs font-bold text-orange-700 transition hover:bg-orange-100"
                    onClick={() => removeFilter(chip.key)}
                    title="Remove this filter"
                    type="button"
                  >
                    {chip.label}
                    <X className="h-3 w-3" />
                  </button>
                ))
              )}
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500" /> : null}
            </div>
            <a
              className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-sm bg-slate-900 px-3.5 text-phx-sm font-bold text-white transition hover:bg-slate-800"
              href={exportHref}
            >
              <Download className="h-3.5 w-3.5" />
              Export Excel
            </a>
          </div>

          <p className="rounded-sm border border-orange-200 bg-orange-50/70 px-4 py-2.5 text-phx-xs font-medium leading-5 text-orange-900">
            This is <strong className="font-bold">not a payroll report</strong> — leave shows its real status (including pending),
            never collapsed to a yes/no, and a <strong className="font-bold">Conflict</strong> day means presence AND a leave
            signal both landed on the same date; it is surfaced for review, never auto-resolved. Click a row, or{" "}
            <strong className="font-bold">Days</strong>, to see the full day-by-day account for that person. The export always
            carries every employee and every day in range, regardless of what is expanded here.
          </p>

          {/* ═══ Results ══════════════════════════════════════════════ */}
          <div className="overflow-hidden rounded-sm border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
            {rows.length === 0 ? (
              <div className="px-6 py-14 text-center">
                <p className="text-base font-extrabold tracking-tight text-slate-900">No employees match this filter</p>
                <p className="mx-auto mt-2 max-w-xl text-phx-md font-medium leading-6 text-slate-500">
                  Nobody in the roster matches {formatDate(startDate)} &rarr; {formatDate(endDate)}
                  {appliedChips.length > 0 ? ` with ${appliedChips.map((chip) => chip.label).join(" · ")}` : ""}. Widen the period
                  or drop a filter above.
                </p>
              </div>
            ) : (
              <>
                {/* Desktop table (md+) */}
                <div className="hidden md:block">
                  <table className="w-full table-fixed border-collapse text-left text-phx-sm">
                    <colgroup>
                      <col style={{ width: "27%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "11%" }} />
                      <col style={{ width: "11%" }} />
                      <col style={{ width: "10%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "9%" }} />
                    </colgroup>
                    <thead className="bg-slate-50 text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500">
                      <tr>
                        <SortableHeader active={sortKey === "employee"} direction={sortDirection} onSort={toggleSort} sortKey="employee">
                          Employee
                        </SortableHeader>
                        <SortableHeader active={sortKey === "workingDays"} direction={sortDirection} onSort={toggleSort} sortKey="workingDays">
                          Working Days
                        </SortableHeader>
                        <SortableHeader active={sortKey === "officePresent"} direction={sortDirection} onSort={toggleSort} sortKey="officePresent">
                          Office
                        </SortableHeader>
                        <SortableHeader active={sortKey === "crmVisits"} direction={sortDirection} onSort={toggleSort} sortKey="crmVisits">
                          CRM Visits
                        </SortableHeader>
                        <SortableHeader active={sortKey === "campaignVisits"} direction={sortDirection} onSort={toggleSort} sortKey="campaignVisits">
                          Campaign
                        </SortableHeader>
                        <SortableHeader active={sortKey === "leaveApproved"} direction={sortDirection} onSort={toggleSort} sortKey="leaveApproved">
                          Leave
                        </SortableHeader>
                        <SortableHeader active={sortKey === "noEntry"} direction={sortDirection} onSort={toggleSort} sortKey="noEntry">
                          No Entry
                        </SortableHeader>
                        <SortableHeader active={sortKey === "conflict"} direction={sortDirection} onSort={toggleSort} sortKey="conflict">
                          Conflict
                        </SortableHeader>
                        <th className="border-b border-slate-100 px-3 py-2.5">Days</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {pageRows.map((row) => (
                        <tr key={row.employeeHrId} className="bg-white align-top transition hover:bg-orange-50/30">
                          <td className="min-w-0 break-words border-r border-slate-100 px-3 py-2.5">
                            <p className="break-words font-bold text-slate-900">{row.employeeName}</p>
                            <p className="mt-0.5 break-words text-phx-xs font-semibold text-slate-800">{row.jobTitle ?? "—"}</p>
                            <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">{orgLine(row)}</p>
                            <NoSignalNote row={row} />
                          </td>
                          <td className="border-r border-slate-100 px-3 py-2.5 text-center font-bold text-slate-900">
                            {row.workingDays}
                          </td>
                          <td className="border-r border-slate-100 px-3 py-2.5 text-center font-semibold text-slate-700">
                            {row.officePresentDays}
                          </td>
                          <td className="border-r border-slate-100 px-3 py-2.5 text-center">
                            <span className="font-semibold text-slate-700">{row.totalCrmVisits}</span>
                            <p className="mt-0.5 text-phx-2xs font-medium text-slate-400">{row.crmFieldVisitDays} field days</p>
                          </td>
                          <td className="border-r border-slate-100 px-3 py-2.5 text-center">
                            <CountBadge tone="accent" value={row.campaignVisits} />
                            <p className="mt-0.5 text-phx-2xs font-medium text-slate-400">
                              {row.campaignVisitDays} {row.campaignVisitDays === 1 ? "day" : "days"}
                              {row.campaignVisitDays > 0 ? ` · ${(row.campaignVisits / row.campaignVisitDays).toFixed(1)}/day` : ""}
                            </p>
                          </td>
                          <td className="border-r border-slate-100 px-3 py-2.5 text-center">
                            <span className="font-semibold text-slate-700">{row.leaveApprovedDays}</span>
                            <p className="mt-0.5 text-phx-2xs font-medium text-slate-400">{row.leavePendingDays} pending</p>
                          </td>
                          <td className="border-r border-slate-100 px-3 py-2.5 text-center">
                            <CountBadge tone="danger" value={row.noEntryDays} />
                          </td>
                          <td className="border-r border-slate-100 px-3 py-2.5 text-center">
                            <CountBadge tone="warn" value={row.conflictDays} />
                          </td>
                          <td className="px-3 py-2.5">
                            <Link
                              className="inline-flex items-center gap-1 rounded-sm border border-slate-200 bg-white px-2.5 py-1 text-phx-xs font-bold text-slate-600 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
                              href={drilldownHref(row.employeeHrId)}
                            >
                              View <ChevronRight className="h-3 w-3" />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards (below md) */}
                <div className="block space-y-2 p-3 md:hidden">
                  {pageRows.map((row) => (
                    <EmployeeSummaryCard key={row.employeeHrId} href={drilldownHref(row.employeeHrId)} row={row} />
                  ))}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5">
                  <p className="text-phx-xs font-semibold text-slate-500">
                    Showing {safePage * PAGE_SIZE + 1}&ndash;{safePage * PAGE_SIZE + pageRows.length} of {rows.length} employees ·
                    the export covers all {rows.length} and every day in range
                  </p>
                  {pageCount > 1 ? (
                    <div className="flex items-center gap-2">
                      <button
                        className="inline-flex h-8 items-center whitespace-nowrap rounded-sm border border-slate-200 bg-white px-3 text-phx-xs font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                        disabled={safePage === 0}
                        onClick={() => setPage(safePage - 1)}
                        type="button"
                      >
                        Previous
                      </button>
                      <span className="whitespace-nowrap text-phx-xs font-bold text-slate-500">
                        Page {safePage + 1} of {pageCount}
                      </span>
                      <button
                        className="inline-flex h-8 items-center whitespace-nowrap rounded-sm border border-slate-200 bg-white px-3 text-phx-xs font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                        disabled={safePage >= pageCount - 1}
                        onClick={() => setPage(safePage + 1)}
                        type="button"
                      >
                        Next
                      </button>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
