"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ArrowUpRight, Download, Filter, Loader2, Plus, RotateCcw, Search } from "lucide-react";
import Link from "next/link";

import {
  AdminSectionHeader,
  adminInsetPanelClassName,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

const monthOptions = Array.from({ length: 12 }, (_, index) => ({
  label: new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, index, 1))),
  value: String(index + 1),
}));

function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
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
      <span className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">{label}</span>
      <SearchableSelect
        className="mt-2 h-10 w-full rounded-xl border border-[#CBD5E1] bg-white px-3 text-sm font-semibold text-[#0F172A] shadow-sm outline-none transition focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC] disabled:text-[#94A3B8]"
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
    <span className={cn("inline-flex rounded-full border px-2.5 py-1 text-[11px] font-black", className)}>
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
              <span className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-black text-orange-700">
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
              <span className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Date From</span>
              <Input
                className="mt-2 rounded-xl border-[#CBD5E1] bg-white font-semibold"
                onChange={(event) => updateFilter("dateFrom", event.target.value)}
                type="date"
                value={filters.dateFrom}
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Date To</span>
              <Input
                className="mt-2 rounded-xl border-[#CBD5E1] bg-white font-semibold"
                onChange={(event) => updateFilter("dateTo", event.target.value)}
                type="date"
                value={filters.dateTo}
              />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[#0F172A] px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_40px_rgba(15,23,42,0.16)] transition hover:bg-[#F97316] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isLoading}
              onClick={applyFilters}
              type="button"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Apply Filters
            </button>
            <button
              className="inline-flex items-center justify-center gap-2 rounded-full border border-[#CBD5E1] bg-white px-5 py-2.5 text-sm font-black text-[#0F172A] shadow-sm transition hover:border-[#F97316]/50 hover:text-[#F97316] disabled:cursor-not-allowed disabled:opacity-60"
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
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E2E8F0] px-5 py-4 sm:px-6">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#F97316]">Reports</p>
            <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-[#0F172A]">
              Coaching reports center
            </h2>
            <p className="mt-1 text-sm leading-6 text-[#64748B]">
              {reports.length} report{reports.length === 1 ? "" : "s"} in the current view.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {error ? (
              <span className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-black text-rose-700">
                {error}
              </span>
            ) : null}
            {canExport ? (
              <button
                className="inline-flex items-center justify-center gap-2 rounded-full border border-[#CBD5E1] bg-white px-4 py-2 text-sm font-black text-[#0F172A] shadow-sm transition hover:border-[#F97316]/50 hover:text-[#F97316] disabled:cursor-not-allowed disabled:opacity-60"
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
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[#F97316] px-4 py-2 text-sm font-black text-white shadow-[0_14px_34px_rgba(249,115,22,0.20)] transition hover:bg-[#EA580C]"
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
            <div className="rounded-lg border border-dashed border-[#CBD5E1] bg-[#F8FAFC] p-8 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-md bg-white text-[#F97316] shadow-sm ring-1 ring-[#E2E8F0]">
                <Filter className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-xl font-black tracking-[-0.03em] text-[#0F172A]">
                No coaching reports found.
              </h3>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[#64748B]">
                Try adjusting the filters or create a new coaching report if you are authorized to do so.
              </p>
              {canCreate ? (
                <Link
                  className="mt-5 inline-flex items-center justify-center gap-2 rounded-full bg-[#F97316] px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_42px_rgba(249,115,22,0.22)] transition hover:bg-[#EA580C]"
                  href={createHref}
                >
                  <Plus className="h-4 w-4" />
                  Create Coaching Report
                </Link>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto overflow-y-auto max-h-[72vh]">
            <table className="min-w-[1180px] w-full border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-slate-900">
                <tr className="border-b border-slate-700 text-[11px] font-black uppercase tracking-[0.14em] text-slate-300">
                  <th className="px-5 py-3">Report Number</th>
                  <th className="px-5 py-3">Medical Rep</th>
                  <th className="px-5 py-3">HR ID</th>
                  <th className="px-5 py-3">Coach</th>
                  <th className="px-5 py-3">Line</th>
                  <th className="px-5 py-3">Area</th>
                  <th className="px-5 py-3">Team</th>
                  <th className="px-5 py-3">Coaching Date</th>
                  <th className="px-5 py-3">Final Score</th>
                  <th className="px-5 py-3">Performance Zone</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Acknowledgment</th>
                  <th className="px-5 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr className="border-b border-[#E2E8F0] bg-white text-sm last:border-b-0 hover:bg-[#FFFBF7]" key={report.reportId}>
                    <td className="px-5 py-4">
                      <span className="font-black text-[#0F172A]">{report.reportNumber}</span>
                    </td>
                    <td className="px-5 py-4 font-semibold text-[#0F172A]">{formatEmployeeDisplayName(report.medicalRepName)}</td>
                    <td className="px-5 py-4 font-mono text-xs font-black text-[#475569]">{report.medicalRepHrId}</td>
                    <td className="px-5 py-4 font-semibold text-[#0F172A]">{formatEmployeeDisplayName(report.coachName)}</td>
                    <td className="px-5 py-4 text-[#475569]">{report.lineName || "Not assigned"}</td>
                    <td className="px-5 py-4 text-[#475569]">{report.areaName || "Not assigned"}</td>
                    <td className="px-5 py-4 text-[#475569]">{report.teamName || "Not assigned"}</td>
                    <td className="px-5 py-4 text-[#475569]">{formatDate(report.coachingDate)}</td>
                    <td className="px-5 py-4 font-black text-[#0F172A]">{formatPercent(report.finalScorePercent)}</td>
                    <td className="px-5 py-4">
                      <Badge className={zoneClassName(report.performanceZone)}>{zoneLabel(report.performanceZone)}</Badge>
                    </td>
                    <td className="px-5 py-4">
                      <Badge className={statusClassName(report.status)}>{statusLabel(report.status)}</Badge>
                    </td>
                    <td className="px-5 py-4">
                      <Badge className={report.acknowledged ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}>
                        {report.acknowledged ? "Acknowledged" : "Pending"}
                      </Badge>
                    </td>
                    <td className="px-5 py-4">
                      <Link
                        className="inline-flex items-center gap-2 rounded-full border border-[#CBD5E1] bg-white px-3 py-1.5 text-xs font-black text-[#0F172A] shadow-sm transition hover:border-[#F97316]/50 hover:text-[#F97316]"
                        href={detailHrefFor(detailHrefBase, report.reportId)}
                      >
                        View Report
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
