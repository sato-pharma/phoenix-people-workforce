"use client";

import { useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  Download,
  Filter,
  Loader2,
  SlidersHorizontal,
  X,
} from "lucide-react";

import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";
import {
  companyVacationLeaveTypeLabel,
  companyVacationReportFilterParams,
  countActiveCompanyVacationReportFilters,
  describeCompanyVacationReportFilterList,
  COMPANY_VACATION_LEAVE_TYPES,
  COMPANY_VACATION_REPORT_APPLIED_PARAM,
  NO_COMPANY_VACATION_REPORT_FILTERS,
  type CompanyVacationHasBalanceFilter,
  type CompanyVacationReportFilters,
} from "@/lib/vacation/company-vacation-report-filters";
import type { CompanyVacationReportRow } from "@/lib/vacation/company-vacation-report";
// VALUES come from the leaf modules, never from company-vacation-report itself: this is a client
// component, and that module reaches node:crypto through @/lib/crm/reads. A type import is erased
// and safe; a value import fails the build outright with UnhandledSchemeError naming this file.
// The same rule applies to company-vacation-report-options, which reads the database — TYPE ONLY.
import {
  companyVacationSourceSystem,
  COMPANY_VACATION_REPORT_SOURCES,
  COMPANY_VACATION_SOURCE_SYSTEMS,
  type CompanyVacationReportSource,
  type CompanyVacationSourceSystem,
} from "@/lib/vacation/company-vacation-report-source";
import type { CompanyVacationReportFilterOptions } from "@/lib/vacation/company-vacation-report-options";
import {
  companyVacationReportRangeParams,
  COMPANY_VACATION_REPORT_EARLIEST_DATE,
} from "@/lib/vacation/company-vacation-report-range";
import {
  phxLabelTextClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Constants ────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

const PAGE_SIZE = 50;

/** The same presets the sibling report offers (src/components/vacation/vacation-report.tsx), with
 * the same labels and the same arithmetic — this is the second vacation screen in the module and
 * the two must not disagree about what "this quarter" covers. */
const DATE_PRESETS = [
  { label: "This month", value: "this_month" },
  { label: "Last month", value: "last_month" },
  { label: "This quarter", value: "this_quarter" },
  { label: "This year", value: "this_year" },
] as const;

type DatePreset = (typeof DATE_PRESETS)[number]["value"];

const selectClass  = phxSelectClassName;

const labelClass = phxLabelTextClassName;

const SOURCE_BADGE_CLASS: Record<CompanyVacationReportSource, string> = {
  "HR Approved": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "HR Cancelled": "border-slate-200 bg-slate-100 text-slate-600",
  "HR Pending": "border-amber-200 bg-amber-50 text-amber-700",
  "HR Rejected": "border-rose-200 bg-rose-50 text-rose-700",
  "CRM Signal — Vacation": "border-sky-200 bg-sky-50 text-sky-700",
  "CRM Signal — Half-Day (Attendance Partial)": "border-yellow-200 bg-yellow-50 text-yellow-800",
};

/** The coarse where-did-this-come-from answer, deliberately louder than the detail badge beside
 * it: it is the first question asked of this report and the one the two colours have to separate
 * at a glance. */
const SOURCE_SYSTEM_BADGE_CLASS: Record<CompanyVacationSourceSystem, string> = {
  Phoenix: "border-orange-300 bg-orange-50 text-orange-800",
  CRM: "border-sky-300 bg-sky-50 text-sky-800",
};

/** Derived from the domain list rather than re-typed here: a seventh source added to the report
 * has to appear in this dropdown too, and a second hand-maintained copy is a second thing that
 * silently disagrees with the first. */
const SOURCE_FILTERS: Array<CompanyVacationReportSource | "All"> = ["All", ...COMPANY_VACATION_REPORT_SOURCES];

type SortDirection = "asc" | "desc";
type SortKey = "days" | "employee" | "source" | "start";

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

function formatDays(days: number) {
  return `${Number(days.toFixed(2))}`;
}

// DATE-ONLY (leave start/end days and window bounds, all `date` columns), which `new Date` parses as
// UTC midnight. UTC here is CORRECT and must stay: it is what stops the calendar day being shifted by a
// zone offset. Not an instant — do not "fix" this one to Cairo.
function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function isCrmSignalSource(source: CompanyVacationReportSource) {
  return source.startsWith("CRM Signal");
}

function rowKey(row: CompanyVacationReportRow) {
  return `${row.hrId}|${row.startDate}|${row.source}`;
}

function compareRows(
  left: CompanyVacationReportRow,
  right: CompanyVacationReportRow,
  key: SortKey,
  direction: SortDirection,
) {
  const factor = direction === "asc" ? 1 : -1;
  switch (key) {
    case "days":
      return (left.workingDays - right.workingDays) * factor;
    case "employee":
      return left.employeeName.localeCompare(right.employeeName, undefined, { sensitivity: "base" }) * factor;
    case "source":
      return left.source.localeCompare(right.source) * factor;
    case "start":
      return left.startDate.localeCompare(right.startDate) * factor;
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Badges ───────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

const badgeBase = "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-phx-xs";

function SourceSystemBadge({ source }: { source: CompanyVacationReportSource }) {
  const system = companyVacationSourceSystem(source);
  return <span className={cn(badgeBase, "font-bold", SOURCE_SYSTEM_BADGE_CLASS[system])}>{system}</span>;
}

function SourceBadge({ source }: { source: CompanyVacationReportSource }) {
  return <span className={cn(badgeBase, "font-semibold", SOURCE_BADGE_CLASS[source])}>{source}</span>;
}

function HasBalanceBadge({ hasBalance }: { hasBalance: boolean | null }) {
  if (hasBalance === null) return <span className="text-phx-xs font-semibold text-slate-400">—</span>;
  return (
    <span
      className={cn(
        badgeBase,
        "font-semibold",
        hasBalance ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700",
      )}
    >
      {hasBalance ? "Yes" : "No"}
    </span>
  );
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
  tone: "blue" | "emerald" | "orange" | "slate" | "violet";
  value: number | string;
}) {
  const toneMap = {
    blue: { bg: "bg-sky-50", border: "border-sky-100", label: "text-sky-600", value: "text-sky-900" },
    emerald: { bg: "bg-emerald-50", border: "border-emerald-100", label: "text-emerald-600", value: "text-emerald-900" },
    orange: { bg: "bg-orange-50", border: "border-orange-100", label: "text-orange-600", value: "text-orange-900" },
    slate: { bg: "bg-slate-50", border: "border-slate-200", label: "text-slate-500", value: "text-slate-900" },
    violet: { bg: "bg-violet-50", border: "border-violet-100", label: "text-violet-600", value: "text-violet-900" },
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
      className="cursor-pointer select-none break-words border-b border-r border-slate-100 px-3 py-2.5 transition hover:bg-slate-100"
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
/* ─── Approve control (write path — Super Admin only) ──────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * Turns one CRM Signal row into a real, approved, balance-deducting vacation request. Only ever
 * fires on an explicit click + confirm, one row at a time — never bulk. See
 * app/api/vacation/company-report/approve/route.ts for what this actually does.
 */
function ApproveControl({
  onApprove,
  row,
}: {
  onApprove: (row: CompanyVacationReportRow) => Promise<void>;
  row: CompanyVacationReportRow;
}) {
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (state === "done") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-phx-xs font-bold text-emerald-700">
        <Check className="h-3.5 w-3.5" /> Approved
      </span>
    );
  }

  const halfDayLabel = row.dayPart === "am_only" ? " (AM)" : row.dayPart === "pm_only" ? " (PM)" : "";
  const handleClick = async () => {
    const confirmed = window.confirm(
      `Approve this as a REAL vacation request for ${row.employeeName}?\n\n` +
      `${row.startDate}${row.endDate !== row.startDate ? ` – ${row.endDate}` : ""} · ${row.workingDays} day(s)${halfDayLabel}\n\n` +
      "This will create an approved vacation_requests record and deduct it from their actual leave entitlement. " +
      "This is not reversible from this page. Continue?",
    );
    if (!confirmed) return;
    setState("pending");
    setErrorMessage(null);
    try {
      await onApprove(row);
      setState("done");
    } catch (error) {
      setState("error");
      setErrorMessage(error instanceof Error ? error.message : "Approval failed.");
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        className={cn(
          "inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-2.5 py-1 text-phx-xs font-bold transition",
          state === "pending"
            ? "cursor-wait border-slate-200 bg-slate-100 text-slate-400"
            : "border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100",
        )}
        disabled={state === "pending"}
        onClick={handleClick}
        type="button"
      >
        {state === "pending" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {state === "pending" ? "Approving…" : "Approve as real leave"}
      </button>
      {state === "error" && errorMessage ? (
        <span className="max-w-[220px] text-phx-xs font-semibold leading-4 text-rose-600">{errorMessage}</span>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Mobile row card ──────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * The admin shell shows full tables on desktop and cards on mobile — the owner's standing rule,
 * and the reason tests/employee-portal-navigation.test.ts refuses a very wide table in this folder:
 * a desktop table that merely scrolls sideways is not a mobile data strategy. The previous version
 * of this report had no card view at all.
 */
function VacationRowCard({
  canApprove,
  onApprove,
  row,
}: {
  canApprove: boolean;
  onApprove: (row: CompanyVacationReportRow) => Promise<void>;
  row: CompanyVacationReportRow;
}) {
  return (
    <div className="rounded-sm border border-slate-200 bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-phx-md font-bold text-slate-900">{row.employeeName}</p>
          <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
            {[row.jobTitle, row.lineName].filter(Boolean).join(" / ") || "—"}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <SourceSystemBadge source={row.source} />
        </div>
      </div>

      <div className="mt-2">
        <SourceBadge source={row.source} />
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-2">
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">From</p>
          <p className="mt-0.5 break-words text-phx-sm font-semibold text-slate-700">{formatDate(row.startDate)}</p>
        </div>
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">To</p>
          <p className="mt-0.5 break-words text-phx-sm font-semibold text-slate-700">{formatDate(row.endDate)}</p>
        </div>
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Days</p>
          <p className="mt-0.5 text-phx-sm font-extrabold text-slate-900">{formatDays(row.workingDays)}</p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Balance</p>
        <HasBalanceBadge hasBalance={row.hasBalance} />
        {row.balanceAfterDays != null ? (
          <span className="whitespace-nowrap text-phx-sm font-semibold text-slate-700">
            <span className="text-slate-400">&rarr;</span> {formatDays(row.balanceAfterDays)} left
          </span>
        ) : null}
      </div>

      {row.detail ? (
        <p className="mt-2 rounded-sm border border-slate-100 bg-slate-50/70 px-2.5 py-2 text-phx-xs font-semibold leading-4 text-slate-700">
          {companyVacationLeaveTypeLabel(row.detail)}
        </p>
      ) : null}

      {canApprove && isCrmSignalSource(row.source) ? (
        <div className="mt-2">
          <ApproveControl onApprove={onApprove} row={row} />
        </div>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Report ───────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

export function CompanyVacationReportTable({
  applied,
  canApprove,
  endDate,
  filters,
  options,
  rows,
  startDate,
}: {
  /** Whether the reader has pressed Apply. Owner instruction 2026-08-27 — "the page is empty, but
   * I have advanced filters ... I filter, then what I filtered on appears" — so this separates
   * "you have not asked yet" from "your filter matched nothing": two states that look identical if
   * you only count rows, and only one of which is a dead end. */
  applied: boolean;
  /** Whether this reader may turn a CRM Signal row into a real, balance-deducting vacation
   * request. False for every read-only reader (owner instruction 2026-08-27: the SFE Manager reads
   * and exports this report, and adds nothing). No default — the caller must decide, so a new
   * surface cannot pick up write controls by forgetting the prop. The button is only the courtesy
   * half: app/api/vacation/company-report/approve asserts system-administrator access on every
   * POST regardless of what this renders. */
  canApprove: boolean;
  endDate: string;
  /** Already applied SERVER-side. These are here to re-fill the panel and to name what is on
   * screen — never to narrow `rows` a second time. */
  filters: CompanyVacationReportFilters;
  options: CompanyVacationReportFilterOptions;
  rows: CompanyVacationReportRow[];
  startDate: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startFilterTransition] = useTransition();

  // Draft state is what the reader is BUILDING, not what the screen is showing. The two are
  // deliberately separate — the panel must be editable without the table shifting underneath — and
  // they are reconciled by the page remounting this component whenever the applied query changes
  // (see the `key` it passes), so no effect is needed to re-sync them. That matters here:
  // setState inside useEffect is a lint error in this repo.
  const [draft, setDraft] = useState<CompanyVacationReportFilters>(filters);
  const [draftStart, setDraftStart] = useState(startDate);
  const [draftEnd, setDraftEnd] = useState(endDate);
  const [panelOpen, setPanelOpen] = useState(!applied);
  const [sortKey, setSortKey] = useState<SortKey>("start");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [page, setPage] = useState(0);

  const activeFilterCount = countActiveCompanyVacationReportFilters(filters);
  const draftFilterCount = countActiveCompanyVacationReportFilters(draft);
  const appliedChips = useMemo(() => describeCompanyVacationReportFilterList(filters), [filters]);

  const setDraftField = <K extends keyof CompanyVacationReportFilters>(
    key: K,
    value: CompanyVacationReportFilters[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  /** The one navigation in this component. EVERY filter, the date range included, is a query
   * parameter resolved on the server: narrowing in the browser could only ever hide rows already
   * fetched, so picking an earlier start date would silently return nothing at all. */
  const runQuery = (nextFilters: CompanyVacationReportFilters, nextStart: string, nextEnd: string) => {
    const params = companyVacationReportRangeParams({ endDate: nextEnd, startDate: nextStart });
    for (const [key, value] of companyVacationReportFilterParams(nextFilters)) params.set(key, value);
    params.set(COMPANY_VACATION_REPORT_APPLIED_PARAM, "1");
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
   * screen, so clicking it has to change the screen, not a form the reader must then submit. */
  const removeFilter = (key: keyof CompanyVacationReportFilters) => {
    const next = { ...filters, [key]: NO_COMPANY_VACATION_REPORT_FILTERS[key] };
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
    const employees = new Set<string>();
    let totalDays = 0;
    let phoenixDays = 0;
    let crmDays = 0;
    for (const row of rows) {
      employees.add(row.hrId);
      totalDays += row.workingDays;
      if (companyVacationSourceSystem(row.source) === "CRM") crmDays += row.workingDays;
      else phoenixDays += row.workingDays;
    }
    return { crmDays, employees: employees.size, phoenixDays, totalDays };
  }, [rows]);

  // The export is a plain GET that re-runs the same query server-side, so the whole filter has to
  // ride along in the URL: without it the workbook ships the entire range while the counter beside
  // this link is describing a slice of it.
  const exportHref = useMemo(() => {
    const params = companyVacationReportRangeParams({ endDate, startDate });
    for (const [key, value] of companyVacationReportFilterParams(filters)) params.set(key, value);
    return `/api/vacation/company-report/export?${params.toString()}`;
  }, [endDate, filters, startDate]);

  const handleApprove = async (row: CompanyVacationReportRow) => {
    const response = await fetch("/api/vacation/company-report/approve", {
      body: JSON.stringify({
        dayPart: row.dayPart,
        detail: row.detail,
        endDate: row.endDate,
        hrId: row.hrId,
        startDate: row.startDate,
        workingDays: row.workingDays,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) {
      throw new Error(body?.message || "Approval failed.");
    }
    router.refresh();
  };

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
                  min={COMPANY_VACATION_REPORT_EARLIEST_DATE}
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
              <label className="space-y-1.5 xs:col-span-2">
                <span className={labelClass}>Employee</span>
                <SearchableSelect
                  className={selectClass}
                  onChange={(event) => setDraftField("employeeHrId", event.target.value)}
                  value={draft.employeeHrId}
                >
                  <option value="All">All employees</option>
                  {options.employees.map((employee) => (
                    <option key={employee.hrId} value={employee.hrId}>
                      {employee.label}
                    </option>
                  ))}
                </SearchableSelect>
              </label>
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
              <label className="space-y-1.5">
                <span className={labelClass}>Line</span>
                <SearchableSelect
                  className={selectClass}
                  onChange={(event) => setDraftField("lineName", event.target.value)}
                  value={draft.lineName}
                >
                  <option value="All">All lines</option>
                  {options.lineNames.map((lineName) => (
                    <option key={lineName} value={lineName}>{lineName}</option>
                  ))}
                </SearchableSelect>
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Source</span>
                <select
                  aria-label="Source system"
                  className={selectClass}
                  onChange={(event) => setDraftField("sourceSystem", event.target.value)}
                  value={draft.sourceSystem}
                >
                  <option value="All">All sources</option>
                  {COMPANY_VACATION_SOURCE_SYSTEMS.map((option) => (
                    <option key={option} value={option}>
                      {option === "Phoenix" ? "Phoenix (submitted here)" : "CRM (iReports360)"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Detail Type</span>
                <select
                  aria-label="Source detail type"
                  className={selectClass}
                  onChange={(event) => setDraftField("source", event.target.value)}
                  value={draft.source}
                >
                  {SOURCE_FILTERS.map((option) => (
                    <option key={option} value={option}>{option === "All" ? "All detail types" : option}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Leave Type</span>
                <select
                  aria-label="Leave type"
                  className={selectClass}
                  onChange={(event) => setDraftField("leaveType", event.target.value)}
                  value={draft.leaveType}
                >
                  <option value="All">All leave types</option>
                  {COMPANY_VACATION_LEAVE_TYPES.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Has Balance</span>
                <select
                  aria-label="Has balance"
                  className={selectClass}
                  onChange={(event) => setDraftField("hasBalance", event.target.value as CompanyVacationHasBalanceFilter)}
                  value={draft.hasBalance}
                >
                  <option value="All">All</option>
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                  <option value="N/A">Not tracked (CRM Signal)</option>
                </select>
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Search</span>
                <input
                  aria-label="Search employee, HR ID, job title or line"
                  className={selectClass}
                  onChange={(event) => setDraftField("query", event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") applyDraft();
                  }}
                  placeholder="Name, HR ID, job title, line"
                  type="text"
                  value={draft.query}
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              {draftFilterCount > 0 ? (
                <button
                  className="inline-flex h-9 items-center whitespace-nowrap rounded-sm border border-slate-200 bg-white px-3 text-phx-sm font-bold text-slate-600 transition hover:bg-slate-50"
                  onClick={() => setDraft(NO_COMPANY_VACATION_REPORT_FILTERS)}
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
            <SlidersHorizontal className="h-5 w-5" />
          </div>
          <p className="mt-4 text-base font-extrabold tracking-tight text-slate-900">Nothing loaded yet</p>
          <p className="mx-auto mt-2 max-w-xl text-phx-md font-medium leading-6 text-slate-500">
            Pick a period and any filters above, then press <strong className="font-bold text-slate-700">Apply Filters</strong>.
            Only what you filter on appears here — this report never loads the whole company at once.
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
            <MetricCard description="Leave entries matching this filter." label="Rows" tone="slate" value={rows.length} />
            <MetricCard description="Distinct people in this result." label="Employees" tone="blue" value={totals.employees} />
            <MetricCard
              description="Sum of days across every row shown."
              label="Total Days"
              tone="violet"
              value={formatDays(totals.totalDays)}
            />
            <MetricCard
              description="Days from requests submitted on Phoenix."
              label="Phoenix Days"
              tone="orange"
              value={formatDays(totals.phoenixDays)}
            />
            <MetricCard
              description="Days read out of iReports360 before Phoenix CRM, unverified. From 6 Nov 2026 leave is the approved Phoenix requests alone."
              label="CRM Days"
              tone="emerald"
              value={formatDays(totals.crmDays)}
            />
          </div>

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
            <strong className="font-bold">Source</strong> says where the day came from.{" "}
            <strong className="font-bold">Phoenix</strong> — the employee submitted this leave request on this system, and the
            detail badge beside it says where that request stands. <strong className="font-bold">CRM</strong> — nobody submitted
            it here; it was read out of the field CRM, where the day is marked as Annual Vacation, and it is a signal rather than
            a request.
            {canApprove ? (
              <>
                {" "}
                <strong className="font-bold">Approve as real leave</strong> on a CRM Signal row creates an approved vacation
                request and deducts it from that employee&apos;s actual entitlement — one row at a time, only when you click it.
              </>
            ) : (
              <>
                {" "}
                This report is <strong className="font-bold">read-only</strong>: it shows and exports leave, and changes none of
                it. A CRM row stays a signal until HR turns it into a real request.
              </>
            )}{" "}
            <strong className="font-bold">Balance</strong> reflects an actual deduction, so it only carries a value for HR
            Approved rows (excluding compensatory days, which are always fully paid outside the leave balance).
          </p>

          {/* ═══ Results ══════════════════════════════════════════════ */}
          <div className="overflow-hidden rounded-sm border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
            {rows.length === 0 ? (
              <div className="px-6 py-14 text-center">
                <p className="text-base font-extrabold tracking-tight text-slate-900">No leave matches this filter</p>
                <p className="mx-auto mt-2 max-w-xl text-phx-md font-medium leading-6 text-slate-500">
                  Nothing was submitted on Phoenix and nothing was recorded in the CRM for {formatDate(startDate)} &rarr;{" "}
                  {formatDate(endDate)}
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
                      <col style={{ width: "19%" }} />
                      <col style={{ width: "13%" }} />
                      <col style={{ width: "13%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "14%" }} />
                      <col style={{ width: canApprove ? "20%" : "33%" }} />
                      {canApprove ? <col style={{ width: "13%" }} /> : null}
                    </colgroup>
                    <thead className="bg-slate-50 text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500">
                      <tr>
                        <SortableHeader active={sortKey === "employee"} direction={sortDirection} onSort={toggleSort} sortKey="employee">
                          Employee
                        </SortableHeader>
                        <SortableHeader active={sortKey === "source"} direction={sortDirection} onSort={toggleSort} sortKey="source">
                          Source
                        </SortableHeader>
                        <SortableHeader active={sortKey === "start"} direction={sortDirection} onSort={toggleSort} sortKey="start">
                          From / To
                        </SortableHeader>
                        <SortableHeader active={sortKey === "days"} direction={sortDirection} onSort={toggleSort} sortKey="days">
                          Days
                        </SortableHeader>
                        <th className="break-words border-b border-r border-slate-100 px-3 py-2.5">Balance</th>
                        <th
                          className={cn(
                            "break-words border-b border-slate-100 px-3 py-2.5",
                            canApprove ? "border-r" : "",
                          )}
                        >
                          Detail
                        </th>
                        {canApprove ? <th className="break-words border-b border-slate-100 px-3 py-2.5">Review</th> : null}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {pageRows.map((row, index) => (
                        <tr key={`${rowKey(row)}-${index}`} className="bg-white align-top transition hover:bg-orange-50/30">
                          <td className="break-words border-r border-slate-100 px-3 py-2.5">
                            <p className="font-bold text-slate-900">{row.employeeName}</p>
                            <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
                              {[row.jobTitle, row.lineName].filter(Boolean).join(" / ") || "—"}
                            </p>
                          </td>
                          <td className="break-words border-r border-slate-100 px-3 py-2.5">
                            <SourceSystemBadge source={row.source} />
                            <div className="mt-1">
                              <SourceBadge source={row.source} />
                            </div>
                          </td>
                          <td className="break-words border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-700">
                            <p>{formatDate(row.startDate)}</p>
                            <p>{formatDate(row.endDate)}</p>
                          </td>
                          <td className="break-words border-r border-slate-100 px-3 py-2.5 text-center font-bold text-slate-900">
                            {formatDays(row.workingDays)}
                          </td>
                          <td className="break-words border-r border-slate-100 px-3 py-2.5">
                            <HasBalanceBadge hasBalance={row.hasBalance} />
                            {row.balanceAfterDays != null ? (
                              <p className="mt-0.5 text-phx-xs font-semibold text-slate-600">
                                <span className="text-slate-400">&rarr;</span> {formatDays(row.balanceAfterDays)} left
                              </p>
                            ) : null}
                          </td>
                          <td className={cn("break-words px-3 py-2.5 text-slate-600", canApprove ? "border-r border-slate-100" : "")}>
                            <p className="font-semibold leading-4">{companyVacationLeaveTypeLabel(row.detail)}</p>
                          </td>
                          {canApprove ? (
                            <td className="break-words px-3 py-2.5">
                              {isCrmSignalSource(row.source) ? (
                                <ApproveControl onApprove={handleApprove} row={row} />
                              ) : (
                                <span className="text-phx-xs font-semibold text-slate-400">—</span>
                              )}
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards (below md) */}
                <div className="block space-y-2 p-3 md:hidden">
                  {pageRows.map((row, index) => (
                    <VacationRowCard
                      key={`${rowKey(row)}-${index}`}
                      canApprove={canApprove}
                      onApprove={handleApprove}
                      row={row}
                    />
                  ))}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5">
                  <p className="text-phx-xs font-semibold text-slate-500">
                    Showing {safePage * PAGE_SIZE + 1}&ndash;{safePage * PAGE_SIZE + pageRows.length} of {rows.length} rows ·{" "}
                    {totals.employees} employees · {formatDays(totals.totalDays)} days · the export covers all {rows.length}
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
