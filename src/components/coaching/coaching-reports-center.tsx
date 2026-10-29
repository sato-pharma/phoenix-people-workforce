"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ArrowUpRight, Download, Filter, Loader2, Plus, RotateCcw, Search } from "lucide-react";
import Link from "next/link";

import { formatDateOnly } from "@/lib/date-only";
import {
  AdminSectionHeader,
  adminInsetPanelClassName,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PaginationControls } from "@/components/ui/pagination-controls";
import type {
  CoachingPerformanceZone,
  CoachingReportStatus,
  CoachingReportSummaryRow,
} from "@/lib/coaching/types";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";


type FilterOption = {
  label: string;
  value: string;
};

export type CoachingReportsFilterOptions = {
  areas: FilterOption[];
  coaches: FilterOption[];
  lines: FilterOption[];
  medicalReps: FilterOption[];
  teams: FilterOption[];
};

type CoachingReportsCenterProps = {
  canCreate: boolean;
  canExport: boolean;
  createHref?: string;
  detailHrefBase?: string;
  filterOptions: CoachingReportsFilterOptions;
  initialReports: CoachingReportSummaryRow[];
  lockedCoachHrId?: string | null;
  lockedCoachLabel?: string | null;
};

type FilterState = {
  areaId: string;
  coachHrId: string;
  dateFrom: string;
  dateTo: string;
  lineId: string;
  medicalRepHrId: string;
  month: string;
  performanceZone: string;
  quarter: string;
  status: string;
  teamId: string;
  year: string;
};

type ApiResponse<T> = {
  data?: T;
  error?: string;
  message?: string;
};

const initialFilters: FilterState = {
  areaId: "",
  coachHrId: "",
  dateFrom: "",
  dateTo: "",
  lineId: "",
  medicalRepHrId: "",
  month: "",
  performanceZone: "",
  quarter: "",
  status: "",
  teamId: "",
  year: "",
};

const statusLabels: Record<CoachingReportStatus, string> = {
  cancelled: "Cancelled",
  draft: "Draft",
  locked: "Locked",
  reviewed_by_employee: "Reviewed by Employee",
  submitted: "Submitted",
};

const zoneLabels: Record<CoachingPerformanceZone, string> = {
  critical_red: "Red Zone / Below Expectations",
  excellence_zone: "Excellence Zone / Exceeds Expectations",
  green_zone: "Green Zone / Meets Expectations",
  red_zone: "Red Zone / Below Expectations",
  yellow_zone: "Yellow Zone / Needs Improvement",
};

const statusOptions: { label: string; value: CoachingReportStatus }[] = [
  { label: "Draft", value: "draft" },
  { label: "Submitted", value: "submitted" },
  { label: "Reviewed by Employee", value: "reviewed_by_employee" },
  { label: "Locked", value: "locked" },
  { label: "Cancelled", value: "cancelled" },
];

const zoneOptions: { label: string; value: CoachingPerformanceZone }[] = [
  { label: "Critical Red", value: "critical_red" },
  { label: "Red Zone", value: "red_zone" },
  { label: "Yellow Zone", value: "yellow_zone" },
  { label: "Green Zone", value: "green_zone" },
  { label: "Excellence Zone", value: "excellence_zone" },
];

// DATE-ONLY (month NAMES off a synthetic `Date.UTC`, not a stored value), which `new Date` parses as
// UTC midnight. UTC here is CORRECT and must stay: it is what stops the calendar day being shifted by a
// zone offset. Not an instant — do not "fix" this one to Cairo.
const monthOptions = Array.from({ length: 12 }, (_, index) => ({
  label: new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, index, 1))),
  value: String(index + 1),
}));

function formatDate(value: string | null | undefined) {
  // Parse + format both in local time via the shared helper so the literal
  // date-only value never shifts a day on non-UTC clients (e.g. Cairo browsers).
  return formatDateOnly(value, "en-US", { day: "2-digit", month: "short", year: "numeric" }, "Not set");
}

function formatPercent(value: number | string | null | undefined) {
  const percent = Number(value ?? 0);
  return Number.isFinite(percent) ? `${percent.toFixed(1)}%` : "0.0%";
}

function statusLabel(status: CoachingReportStatus | string | null | undefined) {
  if (!status || !(status in statusLabels)) return "Unknown";
  return statusLabels[status as CoachingReportStatus];
}

function zoneLabel(zone: CoachingPerformanceZone | string | null | undefined) {
  if (!zone || !(zone in zoneLabels)) return "Not scored";
  return zoneLabels[zone as CoachingPerformanceZone];
}

function zoneClassName(zone: CoachingPerformanceZone | string | null | undefined) {
  if (zone === "critical_red" || zone === "red_zone") return "border-rose-200 bg-rose-50 text-rose-700";
  if (zone === "yellow_zone") return "border-orange-200 bg-orange-50 text-orange-700";
  if (zone === "green_zone") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (zone === "excellence_zone") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function statusClassName(status: CoachingReportStatus | string | null | undefined) {
  if (status === "draft") return "border-slate-200 bg-slate-50 text-slate-700";
  if (status === "submitted") return "border-blue-200 bg-blue-50 text-blue-700";
  if (status === "reviewed_by_employee") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "locked") return "border-slate-300 bg-slate-900 text-white";
  if (status === "cancelled") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function SelectField({
  disabled,
  label,
  onChange,
  options,
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  value: string;
}) {
  return (
    <label className="block">
      <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">{label}</span>
      <SearchableSelect
        className="mt-2 w-full px-3 disabled:text-phx-ink-faint"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SearchableSelect>
    </label>
  );
}

function Badge({ children, className }: { children: ReactNode; className: string }) {
  return (
    <span className={cn("inline-flex rounded-full border px-2.5 py-1 text-phx-xs font-black", className)}>
      {children}
    </span>
  );
}

async function fetchReports(filters: FilterState, lockedCoachHrId?: string | null) {
  const params = new URLSearchParams();
  const effectiveFilters = {
    ...filters,
    coachHrId: lockedCoachHrId || filters.coachHrId,
  };

  for (const [key, value] of Object.entries(effectiveFilters)) {
    if (value) params.set(key, value);
  }

  const response = await fetch(`/api/coaching/reports?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({})) as ApiResponse<CoachingReportSummaryRow[]>;
  if (!response.ok) {
    throw new Error(payload.message || "Unable to load coaching reports.");
  }
  return payload.data ?? [];
}

function buildExportParams(filters: FilterState, lockedCoachHrId?: string | null) {
  const params = new URLSearchParams();
  const effectiveFilters = {
    ...filters,
    coachHrId: lockedCoachHrId || filters.coachHrId,
  };

  for (const [key, value] of Object.entries(effectiveFilters)) {
    if (value) params.set(key, value);
  }
  return params;
}

function filenameFromDisposition(value: string | null) {
  const match = value?.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? `phoenix-coaching-reports-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

function detailHrefFor(base: string, reportId: string) {
  return `${base.replace(/\/+$/g, "")}/${reportId}`;
}

const REPORTS_PAGE_SIZE = 25;

export function CoachingReportsCenter({
  canCreate,
  canExport,
  createHref = "/coaching/new",
  detailHrefBase = "/coaching",
  filterOptions,
  initialReports,
  lockedCoachHrId,
  lockedCoachLabel,
}: CoachingReportsCenterProps) {
  const [reports, setReports] = useState(initialReports);
  const [filters, setFilters] = useState<FilterState>(() => ({
    ...initialFilters,
    coachHrId: lockedCoachHrId ?? "",
  }));
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [page, setPage] = useState(0);

  const [prevReports, setPrevReports] = useState(reports);
  if (reports !== prevReports) {
    setPrevReports(reports);
    setPage(0);
  }

  const pageReports = reports.slice(page * REPORTS_PAGE_SIZE, (page + 1) * REPORTS_PAGE_SIZE);

  const years = useMemo(() => {
    const values = new Set(reports.map((report) => String(report.coachingYear)).filter(Boolean));
    values.add(String(new Date().getFullYear()));
    return [...values].sort((left, right) => Number(right) - Number(left));
  }, [reports]);

  const updateFilter = (key: keyof FilterState, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const applyFilters = async () => {
    setIsLoading(true);
    setError(null);
    try {
      setReports(await fetchReports(filters, lockedCoachHrId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load coaching reports.");
    } finally {
      setIsLoading(false);
    }
  };

  const resetFilters = async () => {
    const reset = {
      ...initialFilters,
      coachHrId: lockedCoachHrId ?? "",
    };
    setFilters(reset);
    setIsLoading(true);
    setError(null);
    try {
      setReports(await fetchReports(reset, lockedCoachHrId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load coaching reports.");
    } finally {
      setIsLoading(false);
    }
  };

  const exportExcel = async () => {
    setIsExporting(true);
    setError(null);
    try {
      const params = buildExportParams(filters, lockedCoachHrId);
      const response = await fetch(`/api/coaching/reports/export?${params.toString()}`, {
        headers: {
          Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as ApiResponse<never>;
        throw new Error(payload.message || "Unable to export coaching reports.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filenameFromDisposition(response.headers.get("Content-Disposition"));
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Unable to export coaching reports.");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card className={cn(adminPanelClassName, "p-5 sm:p-6")}>
        <AdminSectionHeader
          title="Report search"
          description="Filter by employee, coach, organization structure, date, status, and performance zone."
          action={
            lockedCoachHrId ? (
              <span className="rounded-full border border-phx-warn-line bg-phx-warn-bg px-3 py-1.5 text-xs font-black text-phx-warn">
                {lockedCoachLabel ? `${lockedCoachLabel}'s reports` : "My coaching reports"}
              </span>
            ) : null
          }
        />

        <div className={cn(adminInsetPanelClassName, "mt-5 p-4")}>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SelectField
              label="Medical Rep"
              onChange={(value) => updateFilter("medicalRepHrId", value)}
              options={filterOptions.medicalReps}
              value={filters.medicalRepHrId}
            />
            <SelectField
              disabled={Boolean(lockedCoachHrId)}
              label="Coach"
              onChange={(value) => updateFilter("coachHrId", value)}
              options={filterOptions.coaches}
              value={filters.coachHrId}
            />
            <SelectField
              label="Line"
              onChange={(value) => updateFilter("lineId", value)}
              options={filterOptions.lines}
              value={filters.lineId}
            />
            <SelectField
              label="Area"
              onChange={(value) => updateFilter("areaId", value)}
              options={filterOptions.areas}
              value={filters.areaId}
            />
            <SelectField
              label="Team"
              onChange={(value) => updateFilter("teamId", value)}
              options={filterOptions.teams}
              value={filters.teamId}
            />
            <SelectField
              label="Status"
              onChange={(value) => updateFilter("status", value)}
              options={statusOptions}
              value={filters.status}
            />
            <SelectField
              label="Performance Zone"
              onChange={(value) => updateFilter("performanceZone", value)}
              options={zoneOptions}
              value={filters.performanceZone}
            />
            <SelectField
              label="Month"
              onChange={(value) => updateFilter("month", value)}
              options={monthOptions}
              value={filters.month}
            />
            <SelectField
              label="Quarter"
              onChange={(value) => updateFilter("quarter", value)}
              options={[
                { label: "Q1", value: "1" },
                { label: "Q2", value: "2" },
                { label: "Q3", value: "3" },
                { label: "Q4", value: "4" },
              ]}
              value={filters.quarter}
            />
            <SelectField
              label="Year"
              onChange={(value) => updateFilter("year", value)}
              options={years.map((year) => ({ label: year, value: year }))}
              value={filters.year}
            />
            <label className="block">
              <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">Date From</span>
              <Input
                className="mt-2"
                onChange={(event) => updateFilter("dateFrom", event.target.value)}
                type="date"
                value={filters.dateFrom}
              />
            </label>
            <label className="block">
              <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">Date To</span>
              <Input
                className="mt-2"
                onChange={(event) => updateFilter("dateTo", event.target.value)}
                type="date"
                value={filters.dateTo}
              />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              className="inline-flex items-center justify-center gap-2 rounded-full bg-phx-ink px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_40px_rgba(15,23,42,0.16)] transition hover:bg-phx-accent disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isLoading}
              onClick={applyFilters}
              type="button"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Apply Filters
            </button>
            <button
              className="inline-flex items-center justify-center gap-2 rounded-full border border-phx-line-strong bg-white px-5 py-2.5 text-sm font-black text-phx-ink shadow-sm transition hover:border-phx-accent/50 hover:text-phx-accent disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isLoading}
              onClick={resetFilters}
              type="button"
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </button>
          </div>
        </div>
      </Card>

      <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-phx-line px-5 py-4 sm:px-6">
          <div>
            <p className="text-phx-xs font-black uppercase tracking-[0.18em] text-phx-accent">Reports</p>
            <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-phx-ink">
              Coaching reports center
            </h2>
            <p className="mt-1 text-sm leading-6 text-phx-ink-soft">
              {reports.length} report{reports.length === 1 ? "" : "s"} in the current view.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {error ? (
              <span className="rounded-full border border-phx-danger-line bg-phx-danger-bg px-3 py-1.5 text-xs font-black text-phx-danger">
                {error}
              </span>
            ) : null}
            {canExport ? (
              <button
                className="inline-flex items-center justify-center gap-2 rounded-full border border-phx-line-strong bg-white px-4 py-2 text-sm font-black text-phx-ink shadow-sm transition hover:border-phx-accent/50 hover:text-phx-accent disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isExporting}
                onClick={exportExcel}
                type="button"
              >
                {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Export Excel
              </button>
            ) : null}
            {canCreate ? (
              <Link
                className="inline-flex items-center justify-center gap-2 rounded-full bg-phx-accent px-4 py-2 text-sm font-black text-white shadow-[0_14px_34px_rgba(249,115,22,0.20)] transition hover:bg-phx-accent-hover"
                href={createHref}
              >
                <Plus className="h-4 w-4" />
                Create New Coaching Report
              </Link>
            ) : null}
          </div>
        </div>

        {reports.length === 0 ? (
          <div className="p-6">
            <div className="rounded-lg border border-dashed border-phx-line-strong bg-phx-paper p-8 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-md bg-white text-phx-accent shadow-sm ring-1 ring-phx-line">
                <Filter className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-xl font-black tracking-[-0.03em] text-phx-ink">
                No coaching reports found.
              </h3>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-phx-ink-soft">
                Try adjusting the filters or create a new coaching report if you are authorized to do so.
              </p>
              {canCreate ? (
                <Link
                  className="mt-5 inline-flex items-center justify-center gap-2 rounded-full bg-phx-accent px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_42px_rgba(249,115,22,0.22)] transition hover:bg-phx-accent-hover"
                  href={createHref}
                >
                  <Plus className="h-4 w-4" />
                  Create Coaching Report
                </Link>
              ) : null}
            </div>
          </div>
        ) : (
          <>
          <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse text-left">
              <colgroup>
                <col className="w-[11%]" />
                <col className="w-[16%]" />
                <col className="w-[14%]" />
                <col className="w-[15%]" />
                <col className="w-[10%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[10%]" />
              </colgroup>
              <thead className="bg-phx-paper">
                <tr className="border-b border-phx-line text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
                  <th className="px-4 py-3">Report #</th>
                  <th className="px-4 py-3">Medical Rep</th>
                  <th className="px-4 py-3">Coach</th>
                  <th className="px-4 py-3">Org</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Score and zone</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageReports.map((report) => (
                  <tr className="border-b border-phx-line bg-white text-sm last:border-b-0 hover:bg-[#FFFBF7]" key={report.reportId}>
                    <td className="px-4 py-3">
                      <span className="font-black text-phx-ink">{report.reportNumber}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="break-words font-semibold text-phx-ink">{formatEmployeeDisplayName(report.medicalRepName)}</div>
                    </td>
                    <td className="break-words px-4 py-3 font-semibold text-phx-ink">{formatEmployeeDisplayName(report.coachName)}</td>
                    <td className="px-4 py-3 text-xs text-phx-ink-2">
                      <div>{report.lineName || "—"}</div>
                      {report.areaName ? <div className="text-phx-ink-faint">{report.areaName}</div> : null}
                      {report.teamName ? <div className="text-phx-ink-faint">{report.teamName}</div> : null}
                    </td>
                    <td className="px-4 py-3 text-phx-ink-2">{formatDate(report.coachingDate)}</td>
                    <td className="px-4 py-3">
                      <div className="font-black text-phx-ink">{formatPercent(report.finalScorePercent)}</div>
                      <Badge className={zoneClassName(report.performanceZone)}>{zoneLabel(report.performanceZone)}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={statusClassName(report.status)}>{statusLabel(report.status)}</Badge>
                      <div className="mt-1">
                        <Badge className={report.acknowledged ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}>
                          {report.acknowledged ? "Acknowledged" : "Pending"}
                        </Badge>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        className="inline-flex items-center gap-2 border border-phx-line-strong bg-white px-3 py-1.5 text-xs font-black text-phx-ink shadow-sm transition hover:border-phx-accent/50 hover:text-phx-accent"
                        href={detailHrefFor(detailHrefBase, report.reportId)}
                      >
                        View
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 p-4 md:hidden">
            {pageReports.map((report) => (
              <div className="border border-phx-line bg-white p-4 shadow-sm" key={`${report.reportId}-mobile`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-black text-phx-ink">{report.reportNumber}</p>
                    <p className="mt-1 break-words font-semibold text-phx-ink">{formatEmployeeDisplayName(report.medicalRepName)}</p>
                  </div>
                  <Badge className={statusClassName(report.status)}>{statusLabel(report.status)}</Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <p className="text-phx-ink-soft">
                    Coach: <span className="font-bold text-phx-ink">{formatEmployeeDisplayName(report.coachName)}</span>
                  </p>
                  <p className="text-phx-ink-soft">
                    Date: <span className="font-bold text-phx-ink">{formatDate(report.coachingDate)}</span>
                  </p>
                  <p className="text-phx-ink-soft">
                    Score: <span className="font-bold text-phx-ink">{formatPercent(report.finalScorePercent)}</span>
                  </p>
                  <p className="text-phx-ink-soft">
                    Org: <span className="font-bold text-phx-ink">{report.lineName || "—"}</span>
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge className={zoneClassName(report.performanceZone)}>{zoneLabel(report.performanceZone)}</Badge>
                    <Badge className={report.acknowledged ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}>
                      {report.acknowledged ? "Ack" : "Pend"}
                    </Badge>
                  </div>
                  <Link
                    className="inline-flex items-center gap-2 border border-phx-line-strong bg-white px-3 py-1.5 text-xs font-black text-phx-ink shadow-sm transition hover:border-phx-accent/50 hover:text-phx-accent"
                    href={detailHrefFor(detailHrefBase, report.reportId)}
                  >
                    View
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>
            ))}
          </div>

          <PaginationControls
            onPageChange={setPage}
            page={page}
            pageSize={REPORTS_PAGE_SIZE}
            total={reports.length}
          />
          </>
        )}
      </Card>
    </div>
  );
}
