"use client";

import {
  AlertTriangle,
  Download,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
  AdminSectionHeader,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ProbationRow, TrafficStatus } from "@/lib/probation/types";
import { cn } from "@/lib/utils";

type Props = {
  initialData: ProbationRow[] | null;
  initialError: string | null;
};

type SortKey =
  | "days-asc"
  | "days-desc"
  | "hire-asc"
  | "hire-desc"
  | "name-asc"
  | "name-desc";

const allValue = "__all__";

const selectClassName =
  "h-10 w-full rounded-xl border border-[#D8E0EA] bg-white px-3 text-sm font-semibold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/12";

const adminTableHeaderClassName =
  "px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-[#64748B]";

function getTrafficStatus(daysRemaining: number): TrafficStatus {
  if (daysRemaining > 60) {
    return "safe";
  }

  if (daysRemaining >= 30) {
    return "warning";
  }

  return "critical";
}

function getProbationProgress(daysRemaining: number) {
  const total = 90;

  return Math.max(0, Math.min(100, Math.round(((total - Math.max(0, daysRemaining)) / total) * 100)));
}

function statusLabel(status: TrafficStatus) {
  if (status === "safe") {
    return "Safe";
  }

  if (status === "warning") {
    return "Warning";
  }

  return "Critical";
}

function formatDate(value: string) {
  const date = new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function uniqueOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function SelectFilter({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
        {label}
      </span>
      <select
        className={selectClassName}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value={allValue}>{label}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function ZoneSelect({
  onChange,
  value,
}: {
  onChange: (value: TrafficStatus | "all") => void;
  value: TrafficStatus | "all";
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
        Zone
      </span>
      <select
        className={selectClassName}
        onChange={(event) => onChange(event.target.value as TrafficStatus | "all")}
        value={value}
      >
        <option value="all">All zones</option>
        <option value="safe">Safe</option>
        <option value="warning">Warning</option>
        <option value="critical">Critical</option>
      </select>
    </label>
  );
}

function SortSelect({
  onChange,
  value,
}: {
  onChange: (value: SortKey) => void;
  value: SortKey;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
        Sort
      </span>
      <select
        className={selectClassName}
        onChange={(event) => onChange(event.target.value as SortKey)}
        value={value}
      >
        <option value="days-asc">Days ascending</option>
        <option value="days-desc">Days descending</option>
        <option value="hire-asc">Hire date ascending</option>
        <option value="hire-desc">Hire date descending</option>
        <option value="name-asc">Name A-Z</option>
        <option value="name-desc">Name Z-A</option>
      </select>
    </label>
  );
}

export function ProbationTracker({ initialData, initialError }: Props) {
  const [areaFilter, setAreaFilter] = useState(allValue);
  const [jobFilter, setJobFilter] = useState(allValue);
  const [lineFilter, setLineFilter] = useState(allValue);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("days-asc");
  const [trafficFilter, setTrafficFilter] = useState<TrafficStatus | "all">("all");
  const [employmentFilter, setEmploymentFilter] = useState<string>(allValue);
  const rows = useMemo(() => initialData ?? [], [initialData]);

  const filterOptions = useMemo(
    () => ({
      areas: uniqueOptions(rows.map((row) => row.area_name)),
      jobs: uniqueOptions(rows.map((row) => row.job_title)),
      lines: uniqueOptions(rows.map((row) => row.line_name)),
      employmentStatuses: uniqueOptions(rows.map((row) => row.employment_status ?? "")),
    }),
    [rows],
  );

  const filteredRows = useMemo(() => {
    const search = query.trim().toLowerCase();

    return rows
      .filter((row) => {
        const searchable = [row.full_name, row.hr_id, row.crm_id].join(" ").toLowerCase();
        const traffic = getTrafficStatus(row.days_remaining);

        return (
          (!search || searchable.includes(search)) &&
          (lineFilter === allValue || row.line_name === lineFilter) &&
          (areaFilter === allValue || row.area_name === areaFilter) &&
          (jobFilter === allValue || row.job_title === jobFilter) &&
          (employmentFilter === allValue || row.employment_status === employmentFilter) &&
          (trafficFilter === "all" || traffic === trafficFilter)
        );
      })
      .sort((left, right) => {
        if (sortBy === "days-desc") {
          return right.days_remaining - left.days_remaining;
        }

        if (sortBy === "hire-asc") {
          return new Date(left.hire_date).getTime() - new Date(right.hire_date).getTime();
        }

        if (sortBy === "hire-desc") {
          return new Date(right.hire_date).getTime() - new Date(left.hire_date).getTime();
        }

        if (sortBy === "name-asc") {
          return left.full_name.localeCompare(right.full_name);
        }

        if (sortBy === "name-desc") {
          return right.full_name.localeCompare(left.full_name);
        }

        return left.days_remaining - right.days_remaining;
      });
  }, [areaFilter, employmentFilter, jobFilter, lineFilter, query, rows, sortBy, trafficFilter]);

  const summary = useMemo(
    () => ({
      critical: filteredRows.filter((row) => getTrafficStatus(row.days_remaining) === "critical").length,
      safe: filteredRows.filter((row) => getTrafficStatus(row.days_remaining) === "safe").length,
      total: filteredRows.length,
      warning: filteredRows.filter((row) => getTrafficStatus(row.days_remaining) === "warning").length,
    }),
    [filteredRows],
  );

  const hasActiveFilters =
    areaFilter !== allValue ||
    jobFilter !== allValue ||
    lineFilter !== allValue ||
    query.length > 0 ||
    sortBy !== "days-asc" ||
    trafficFilter !== "all" ||
    employmentFilter !== allValue;

  const activeFilterCount = [
    areaFilter !== allValue ? areaFilter : "",
    jobFilter !== allValue ? jobFilter : "",
    lineFilter !== allValue ? lineFilter : "",
    query ? query : "",
    sortBy !== "days-asc" ? sortBy : "",
    trafficFilter !== "all" ? trafficFilter : "",
    employmentFilter !== allValue ? employmentFilter : "",
  ].filter(Boolean).length;

  function resetFilters() {
    setAreaFilter(allValue);
    setJobFilter(allValue);
    setLineFilter(allValue);
    setEmploymentFilter(allValue);
    setQuery("");
    setSortBy("days-asc");
    setTrafficFilter("all");
  }

  return (
    <div className="space-y-6">
      <AdminPageHero
        actions={
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <Button
              className="h-10 gap-2 rounded-xl"
              disabled={!hasActiveFilters}
              onClick={resetFilters}
              variant="secondary"
            >
              <RefreshCw className="h-4 w-4" />
              Reset Filters
            </Button>
            <a
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-[#D7E0EA] bg-white px-3 py-2 text-xs font-semibold text-[#0F172A] transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]"
              href="/api/exports?report=probation&format=pdf"
            >
              <Download className="h-4 w-4 text-[#EA580C]" />
              Export PDF
            </a>
            <a
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-[#D7E0EA] bg-white px-3 py-2 text-xs font-semibold text-[#0F172A] transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]"
              href="/api/exports?report=probation&format=xlsx"
            >
              <Download className="h-4 w-4 text-[#EA580C]" />
              Export Excel
            </a>
          </div>
        }
        badges={(
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>Employees in probation: {summary.total}</AdminInsightChip>
            <AdminInsightChip tone="orange">
              {rows.length > 0 ? `${((summary.critical / summary.total) * 100).toFixed(0)}% critical` : "0% critical"}
            </AdminInsightChip>
            <AdminInsightChip tone="slate">
              {summary.warning} warning, {summary.safe} safe
            </AdminInsightChip>
          </div>
        )}
        description="Track employees inside the 90-day probation window and prioritize deadlines by risk zone before deadlines become people-risk."
        eyebrow="People Operations"
        icon={<Shield className="h-3.5 w-3.5" />}
        title="Probation Tracker"
      />

      {initialError ? (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-danger" />
          <div>
            <h2 className="text-base font-semibold text-text">Probation data unavailable</h2>
            <p className="mt-1 text-sm text-text-secondary">{initialError}</p>
          </div>
        </AdminCallout>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          description="Matching current filters"
          icon={<Shield className="h-5 w-5" />}
          label="Total in Probation"
          value={summary.total}
        />
        <AdminStatCard
          description="More than 60 days remaining"
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Safe Zone"
          value={summary.safe}
        />
        <AdminStatCard
          description="30 to 60 days remaining"
          icon={<ShieldAlert className="h-5 w-5" />}
          label="Warning Zone"
          value={summary.warning}
        />
        <AdminStatCard
          description="Less than 30 days remaining"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Critical Zone"
          value={summary.critical}
        />
      </div>

      <AdminTableShell
        action={
          <Button
            className="h-10 gap-2 rounded-xl"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
            variant="secondary"
          >
            <X className="h-4 w-4" />
            {activeFilterCount > 0 ? `Clear (${activeFilterCount})` : "Clear"}
          </Button>
        }
        description="Use line, area, role, employment status, risk zone, and sort to focus on actionable probation windows."
        title="Workflow Filters"
      >
        <div className="grid gap-3 p-4 sm:p-5 xl:grid-cols-[1.5fr_repeat(4,minmax(0,1fr))_auto]">
          <label className="relative block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              Search
            </span>
            <Search className="pointer-events-none absolute left-3 top-10 h-4 w-4 text-text-secondary" />
            <Input
              className="h-10 rounded-xl border-[#D8E0EA] bg-white pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, HR ID, CRM ID"
              value={query}
            />
          </label>
          <SelectFilter
            label="All lines"
            onChange={setLineFilter}
            options={filterOptions.lines}
            value={lineFilter}
          />
          <SelectFilter
            label="All areas"
            onChange={setAreaFilter}
            options={filterOptions.areas}
            value={areaFilter}
          />
          <SelectFilter
            label="All job titles"
            onChange={setJobFilter}
            options={filterOptions.jobs}
            value={jobFilter}
          />
          <SelectFilter
            label="All statuses"
            onChange={setEmploymentFilter}
            options={filterOptions.employmentStatuses}
            value={employmentFilter}
          />
          <ZoneSelect onChange={setTrafficFilter} value={trafficFilter} />
          <SortSelect onChange={setSortBy} value={sortBy} />
        </div>
      </AdminTableShell>

      <Card className={`${adminPanelClassName} overflow-hidden p-0`}>
        <AdminSectionHeader
          action={
            <div className="flex flex-wrap gap-2">
              <Badge variant="warning">{summary.warning} warning</Badge>
              <Badge variant="danger">{summary.critical} critical</Badge>
            </div>
          }
          description={`Showing ${filteredRows.length} of ${rows.length} employees in the active probation window.`}
          title="Current Probation Employees"
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="sticky top-0 bg-[#F8FAFC]">
              <tr className="border-b border-[#E2E8F0] text-xs uppercase tracking-[0.12em] text-text-secondary">
                {[
                  "HR ID",
                  "CRM ID",
                  "Full Name",
                  "Job Title",
                  "Line",
                  "Area",
                  "Hire Date",
                  "End Date",
                  "Days",
                  "Progress",
                  "Status",
                  "Actions",
                ].map((column) => (
                  <th className={adminTableHeaderClassName} key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {filteredRows.length === 0 ? (
                <tr>
                  <td className="px-4 py-12 text-center text-sm text-text-secondary" colSpan={12}>
                    No probation records match the current filters.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => {
                  const traffic = getTrafficStatus(row.days_remaining);
                  const progress = getProbationProgress(row.days_remaining);

                  return (
                    <tr className="transition-colors hover:bg-[#F8FAFC]" key={row.hr_id}>
                      <td className="px-3 py-4 font-mono text-xs text-text-secondary">{row.hr_id || "-"}</td>
                      <td className="px-3 py-4 font-mono text-xs text-text-secondary">{row.crm_id || "-"}</td>
                      <td className="px-3 py-4 font-semibold text-text">{row.full_name}</td>
                      <td className="max-w-[220px] truncate px-3 py-4 text-text-secondary">{row.job_title}</td>
                      <td className="px-3 py-4 text-text-secondary">{row.line_name}</td>
                      <td className="px-3 py-4 text-text-secondary">{row.area_name}</td>
                      <td className="px-3 py-4 text-text-secondary">{formatDate(row.hire_date)}</td>
                      <td className="px-3 py-4 text-text-secondary">{formatDate(row.probation_end_date)}</td>
                      <td className="px-3 py-4 font-semibold text-text">{row.days_remaining}</td>
                      <td className="min-w-[150px] px-3 py-4">
                        <div className="space-y-1">
                          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all",
                                traffic === "safe"
                                  ? "bg-success"
                                  : traffic === "warning"
                                    ? "bg-warning"
                                    : "bg-danger",
                              )}
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                          <p className="text-[11px] leading-tight text-text-secondary">{progress}% complete</p>
                        </div>
                      </td>
                      <td className="px-3 py-4">
                        <Badge variant={traffic === "safe" ? "success" : traffic === "warning" ? "warning" : "danger"}>
                          {statusLabel(traffic)}
                        </Badge>
                      </td>
                      <td className="px-3 py-4">
                        <div className="flex flex-wrap gap-2">
                          <Button className="h-9 rounded-xl px-2.5 text-xs" variant="secondary">
                            Review
                          </Button>
                          <Button className="h-9 rounded-xl px-2.5 text-xs" variant="ghost">
                            Reminder
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
