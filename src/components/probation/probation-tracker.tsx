"use client";

import {
  AlertTriangle,
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

function SummaryCard({
  description,
  icon,
  label,
  value,
}: {
  description: string;
  icon: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {icon}
        </div>
        <div>
          <p className="text-sm text-text-secondary">{label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-text">
            {value}
          </p>
          <p className="mt-0.5 text-xs text-text-secondary">{description}</p>
        </div>
      </div>
    </Card>
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
        className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
  const rows = useMemo(() => initialData ?? [], [initialData]);

  const filterOptions = useMemo(
    () => ({
      areas: uniqueOptions(rows.map((row) => row.area_name)),
      jobs: uniqueOptions(rows.map((row) => row.job_title)),
      lines: uniqueOptions(rows.map((row) => row.line_name)),
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
  }, [areaFilter, jobFilter, lineFilter, query, rows, sortBy, trafficFilter]);

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
    trafficFilter !== "all";

  function resetFilters() {
    setAreaFilter(allValue);
    setJobFilter(allValue);
    setLineFilter(allValue);
    setQuery("");
    setSortBy("days-asc");
    setTrafficFilter("all");
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-primary">
            People Operations
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-text">
            Probation Tracker
          </h1>
          <p className="mt-2 max-w-2xl text-base text-text-secondary">
            Monitor employees inside the 90-day probation window and prioritize
            reviews before deadlines become people-risk.
          </p>
        </div>
        <Button
          className="gap-2"
          disabled={!hasActiveFilters}
          onClick={resetFilters}
          variant="secondary"
        >
          <RefreshCw className="h-4 w-4" />
          Reset
        </Button>
      </div>

      {initialError ? (
        <Card className="border-danger/30">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-danger" />
            <div>
              <h2 className="text-base font-semibold text-text">
                Probation data unavailable
              </h2>
              <p className="mt-1 text-sm text-text-secondary">{initialError}</p>
            </div>
          </div>
        </Card>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          description="Matching current filters"
          icon={<Shield className="h-5 w-5" />}
          label="Total in Probation"
          value={summary.total}
        />
        <SummaryCard
          description="More than 60 days left"
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Safe Zone"
          value={summary.safe}
        />
        <SummaryCard
          description="30 to 60 days left"
          icon={<ShieldAlert className="h-5 w-5" />}
          label="Warning Zone"
          value={summary.warning}
        />
        <SummaryCard
          description="Less than 30 days left"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Critical Zone"
          value={summary.critical}
        />
      </section>

      <Card>
        <div className="grid gap-3 xl:grid-cols-[1.5fr_repeat(5,minmax(0,1fr))_auto]">
          <label className="relative block">
            <span className="sr-only">Search probation employees</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
            <Input
              className="pl-9"
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
          <select
            className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-text"
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
            className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-text"
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
            Clear
          </Button>
        </div>
      </Card>

      <Card>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-xs uppercase tracking-[0.16em] text-text-secondary">
                {[
                  "HR ID",
                  "Full Name",
                  "Job Title",
                  "Line",
                  "Area",
                  "Hire Date",
                  "End Date",
                  "Days",
                  "Progress",
                  "Status",
                ].map((column) => (
                  <th className="px-3 py-3 font-semibold" key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredRows.length === 0 ? (
                <tr>
                  <td
                    className="py-8 text-center text-sm text-text-secondary"
                    colSpan={10}
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
                      className="transition-colors hover:bg-bg-muted"
                      key={row.hr_id}
                    >
                      <td className="px-3 py-4 font-mono text-xs text-text-secondary">
                        {row.hr_id || "-"}
                      </td>
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
                          <div className="h-2 overflow-hidden rounded-full bg-bg-muted">
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
