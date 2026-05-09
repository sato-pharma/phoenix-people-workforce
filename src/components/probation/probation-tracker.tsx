"use client";

import {
  AlertTriangle,
  Download,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

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

  return Math.max(
    0,
    Math.min(100, Math.round(((total - Math.max(0, daysRemaining)) / total) * 100)),
  );
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
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
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

const summaryCardVariants = {
  primary: {
    tone: "bg-slate-50 text-slate-900",
    icon: "bg-white/70 text-primary",
  },
  success: {
    tone: "bg-emerald-50 text-emerald-800",
    icon: "bg-white/70 text-success",
  },
  warning: {
    tone: "bg-orange-50 text-orange-800",
    icon: "bg-white/70 text-warning",
  },
  danger: {
    tone: "bg-rose-50 text-rose-800",
    icon: "bg-white/70 text-danger",
  },
};

function SummaryCard({
  description,
  icon,
  label,
  value,
  variant = "primary",
}: {
  description: string;
  icon: ReactNode;
  label: string;
  value: number;
  variant?: keyof typeof summaryCardVariants;
}) {
  const styles = summaryCardVariants[variant];
  return (
    <div className={cn("rounded-xl border border-slate-200 p-4", styles.tone)}>
      <div className="flex items-start gap-4">
        <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg", styles.icon)}>
          {icon}
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-70">{label}</p>
          <p className="mt-2 font-mono text-2xl font-bold tracking-tight">
            {value}
          </p>
          <p className="mt-1 text-xs opacity-70">{description}</p>
        </div>
      </div>
    </div>
  );
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
      <span className="sr-only">{label}</span>
      <select
        className="h-10 w-full rounded-lg border border-border bg-white px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
        const searchable = [row.full_name, row.hr_id, row.crm_id]
          .join(" ")
          .toLowerCase();
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
    query,
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
    <Card className="overflow-hidden border-slate-200 bg-white p-0 shadow-[0_20px_50px_rgba(15,23,42,0.06)]">
      <div className="border-b border-slate-200 bg-slate-950 px-5 py-5 text-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-orange-300">
              People Operations
            </p>
            <h1 className="mt-2 text-2xl font-bold">Probation Tracker</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-300">
              Monitor employees inside the 90-day probation window and prioritize reviews before deadlines become people-risk.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={summary.critical > 0 ? "danger" : "neutral"}>
              {summary.critical} critical
            </Badge>
          <Button
            className="border-white/15 bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/15"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
            variant="secondary"
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Reset
          </Button>
          <a
            className={cn(
              "inline-flex items-center justify-center rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/15",
            )}
            href="/api/exports?report=probation&format=pdf"
          >
            <Download className="mr-2 h-3.5 w-3.5" />
            Export PDF
          </a>
          <a
            className={cn(
              "inline-flex items-center justify-center rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/15",
            )}
            href="/api/exports?report=probation&format=xlsx"
          >
            <Download className="mr-2 h-3.5 w-3.5" />
            Export Excel
          </a>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5">
      {initialError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-danger" />
            <div>
              <h2 className="text-base font-semibold text-text">
                Probation data unavailable
              </h2>
              <p className="mt-1 text-sm text-text-secondary">{initialError}</p>
            </div>
          </div>
        </div>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          description="Matching current filters"
          icon={<Shield className="h-5 w-5" />}
          label="Total in Probation"
          value={summary.total}
          variant="primary"
        />
        <SummaryCard
          description="More than 60 days left"
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Safe Zone"
          value={summary.safe}
          variant="success"
        />
        <SummaryCard
          description="30 to 60 days left"
          icon={<ShieldAlert className="h-5 w-5" />}
          label="Warning Zone"
          value={summary.warning}
          variant="warning"
        />
        <SummaryCard
          description="Less than 30 days left"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Critical Zone"
          value={summary.critical}
          variant="danger"
        />
      </section>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="grid gap-3 xl:grid-cols-[1.5fr_repeat(5,minmax(0,1fr))_auto]">
          <label className="relative block">
            <span className="sr-only">Search probation employees</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
            <Input
              className="bg-white pl-9"
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
          <select
            className="h-10 rounded-lg border border-border bg-white px-3 text-sm text-text"
            onChange={(event) =>
              setTrafficFilter(event.target.value as TrafficStatus | "all")
            }
            value={trafficFilter}
          >
            <option value="all">All zones</option>
            <option value="safe">Safe</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <select
            className="h-10 rounded-lg border border-border bg-white px-3 text-sm text-text"
            onChange={(event) => setSortBy(event.target.value as SortKey)}
            value={sortBy}
          >
            <option value="days-asc">Days asc</option>
            <option value="days-desc">Days desc</option>
            <option value="hire-asc">Hire date asc</option>
            <option value="hire-desc">Hire date desc</option>
            <option value="name-asc">Name A-Z</option>
            <option value="name-desc">Name Z-A</option>
          </select>
          <Button
            className="gap-2 whitespace-nowrap"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
            variant="secondary"
          >
            <RefreshCw className="h-4 w-4" />
            Clear {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-text">
              Current Probation Employees
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              Showing {filteredRows.length} of {rows.length} employees in the
              active probation window.
            </p>
          </div>
          <div className="flex gap-2">
            <Badge variant="warning">{summary.warning} warning</Badge>
            <Badge variant="danger">{summary.critical} critical</Badge>
          </div>
        </div>

        <div className="max-h-[680px] overflow-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="sticky top-0 bg-slate-100">
              <tr className="border-b border-slate-200 text-xs uppercase tracking-[0.12em] text-text-secondary">
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
                  <th className="px-3 py-3 font-semibold" key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRows.length === 0 ? (
                <tr>
                  <td
                    className="px-4 py-10 text-center text-sm text-text-secondary"
                    colSpan={12}
                  >
                    No probation records match the current filters.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => {
                  const traffic = getTrafficStatus(row.days_remaining);
                  const progress = getProbationProgress(row.days_remaining);

                  return (
                    <tr
                      className="transition-colors hover:bg-slate-50"
                      key={row.hr_id}
                    >
                      <td className="px-3 py-4 font-mono text-xs text-text-secondary">
                        {row.hr_id || "-"}
                      </td>
                      <td className="px-3 py-4 font-mono text-xs text-text-secondary">{row.crm_id || "-"}</td>
                      <td className="px-3 py-4 font-semibold text-text">
                        {row.full_name}
                      </td>
                      <td className="px-3 py-4 text-text-secondary">
                        {row.job_title}
                      </td>
                      <td className="px-3 py-4 text-text-secondary">
                        {row.line_name}
                      </td>
                      <td className="px-3 py-4 text-text-secondary">
                        {row.area_name}
                      </td>
                      <td className="px-3 py-4 text-text-secondary">
                        {formatDate(row.hire_date)}
                      </td>
                      <td className="px-3 py-4 text-text-secondary">
                        {formatDate(row.probation_end_date)}
                      </td>
                      <td className="px-3 py-4 font-semibold text-text">
                        {row.days_remaining}
                      </td>
                      <td className="min-w-[150px] px-3 py-4">
                        <div className="space-y-1.5">
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
                          <p className="text-xs text-text-secondary">
                            {progress}% complete
                          </p>
                        </div>
                      </td>
                      <td className="px-3 py-4">
                        <Badge
                          variant={
                            traffic === "safe"
                              ? "success"
                              : traffic === "warning"
                                ? "warning"
                                : "danger"
                          }
                        >
                          {statusLabel(traffic)}
                        </Badge>
                      </td>
                      <td className="px-3 py-4">
                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary">Review</Button>
                          <Button variant="ghost">Reminder</Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      </div>
    </Card>
  );
}
