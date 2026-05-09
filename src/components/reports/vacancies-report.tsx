"use client";

import {
  AlertCircle,
  BriefcaseBusiness,
  Building2,
  Download,
  Layers3,
  RefreshCw,
  Search,
  UsersRound,
  X,
} from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { VacancyReportData } from "@/lib/reports/vacancies";
import { cn } from "@/lib/utils";

type VacanciesReportProps = {
  initialError?: string | null;
  initialReport?: VacancyReportData | null;
};

function SummaryCard({
  label,
  tone = "warning",
  value,
}: {
  label: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  value: number;
}) {
  const toneClass = {
    danger: "bg-rose-50 text-rose-800",
    neutral: "bg-slate-50 text-slate-900",
    success: "bg-emerald-50 text-emerald-800",
    warning: "bg-orange-50 text-orange-800",
  }[tone];

  return (
    <div className={cn("rounded-xl border border-slate-200 p-4", toneClass)}>
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-70">{label}</p>
      <p className="mt-2 font-mono text-2xl font-bold">
        {value}
      </p>
    </div>
  );
}

function emptyText(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function vacancyLabel(vacancyCode: string) {
  const match = vacancyCode.match(/^vacancy_(?:vac_)?(\d+)/i);

  return match ? `VAC-${match[1]}` : vacancyCode;
}

function uniqueOptions(values: Array<string | null>) {
  return Array.from(new Set(values.filter(Boolean) as string[])).sort((a, b) =>
    a.localeCompare(b),
  );
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function csvCell(value: string | number | null | undefined) {
  const text = emptyText(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function groupCounts(
  rows: VacancyReportData["rows"],
  getKey: (row: VacancyReportData["rows"][number]) => string | null,
) {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const key = getKey(row) ?? "Unassigned";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ count, name }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function MiniBreakdown({
  icon,
  items,
  title,
}: {
  icon: React.ReactNode;
  items: Array<{ count: number; name: string }>;
  title: string;
}) {
  const topItems = items.slice(0, 5);
  const total = items.reduce((sum, item) => sum + item.count, 0);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text">{title}</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Top groups by visible vacancies.
          </p>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-50 text-primary">
          {icon}
        </div>
      </div>

      <div className="mt-5 space-y-3">
        {topItems.length === 0 ? (
          <p className="text-sm text-text-secondary">No data available.</p>
        ) : (
          topItems.map((item) => {
            const width = total > 0 ? `${Math.max((item.count / total) * 100, 6)}%` : "0%";

            return (
              <div key={item.name}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-medium text-text">
                    {item.name}
                  </span>
                  <span className="text-text-secondary">{item.count}</span>
                </div>
                <div className="mt-2 h-2 rounded-full bg-slate-100">
                  <div
                    className="h-2 rounded-full bg-primary shadow-[0_0_12px_rgba(249,115,22,0.24)]"
                    style={{ width }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function SelectFilter({
  className,
  label,
  onChange,
  options,
  value,
}: {
  className?: string;
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="sr-only">{label}</span>
      <select
        className="h-10 w-full rounded-lg border border-border bg-white px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">{label}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function VacanciesReport({
  initialError = null,
  initialReport = null,
}: VacanciesReportProps) {
  const [report, setReport] = React.useState<VacancyReportData | null>(
    initialReport,
  );
  const [error, setError] = React.useState<string | null>(initialError);
  const [isLoading, setIsLoading] = React.useState(false);
  const [areaFilter, setAreaFilter] = React.useState("");
  const [departmentFilter, setDepartmentFilter] = React.useState("");
  const [lineFilter, setLineFilter] = React.useState("");
  const [managerFilter, setManagerFilter] = React.useState("");
  const [positionFilter, setPositionFilter] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [regionFilter, setRegionFilter] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");

  const loadReport = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch("/api/reports/vacancies", {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "vacancy_report_failed");
        return;
      }

      setReport(payload);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error && caughtError.name === "AbortError"
          ? "Vacancy report request timed out. Check Supabase connection and schema setup."
          : "Unable to load vacancy report.",
      );
    } finally {
      window.clearTimeout(timeout);
      setIsLoading(false);
    }
  }, []);
  const filterOptions = React.useMemo(() => {
    const rows = report?.rows ?? [];

    return {
      areas: uniqueOptions(rows.map((row) => row.areaName)),
      departments: uniqueOptions(rows.map((row) => row.departmentName)),
      lines: uniqueOptions(rows.map((row) => row.lineName)),
      managers: uniqueOptions(rows.map((row) => row.managerName)),
      positions: uniqueOptions(
        rows.map((row) => row.positionTitle ?? row.jobTitle),
      ),
      regions: uniqueOptions(rows.map((row) => row.regionName)),
      statuses: uniqueOptions(rows.map((row) => row.status)),
    };
  }, [report]);
  const filteredRows = React.useMemo(() => {
    const rows = report?.rows ?? [];
    const normalizedQuery = query.trim().toLowerCase();

    return rows.filter((row) => {
      const position = row.positionTitle ?? row.jobTitle;
      const searchable = [
        vacancyLabel(row.vacancyCode),
        row.vacancyCode,
        row.departmentName,
        row.lineName,
        row.areaName,
        row.managerName,
        row.managerHrId,
        position,
        row.regionName,
        row.status,
        row.sourceRowNumber ? `row ${row.sourceRowNumber}` : null,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        (!normalizedQuery || searchable.includes(normalizedQuery)) &&
        (!departmentFilter || row.departmentName === departmentFilter) &&
        (!lineFilter || row.lineName === lineFilter) &&
        (!managerFilter || row.managerName === managerFilter) &&
        (!regionFilter || row.regionName === regionFilter) &&
        (!areaFilter || row.areaName === areaFilter) &&
        (!positionFilter || position === positionFilter) &&
        (!statusFilter || row.status === statusFilter)
      );
    });
  }, [
    areaFilter,
    departmentFilter,
    lineFilter,
    managerFilter,
    positionFilter,
    query,
    regionFilter,
    report,
    statusFilter,
  ]);
  const filteredSummary = React.useMemo(() => {
    const openRows = filteredRows.filter((row) => row.status === "open");

    return {
      areasAffected: uniqueOptions(openRows.map((row) => row.areaName)).length,
      linesAffected: uniqueOptions(openRows.map((row) => row.lineName)).length,
      openVacancies: openRows.length,
      positionsAffected: uniqueOptions(
        openRows.map((row) => row.positionTitle ?? row.jobTitle),
      ).length,
    };
  }, [filteredRows]);
  const breakdowns = React.useMemo(
    () => ({
      lines: groupCounts(filteredRows, (row) => row.lineName),
      managers: groupCounts(filteredRows, (row) => row.managerName),
      regions: groupCounts(filteredRows, (row) => row.regionName),
    }),
    [filteredRows],
  );
  const hasActiveFilters = Boolean(
    areaFilter ||
      departmentFilter ||
      lineFilter ||
      managerFilter ||
      positionFilter ||
      query ||
      regionFilter ||
      statusFilter,
  );
  const activeFilterCount = [
    areaFilter,
    departmentFilter,
    lineFilter,
    managerFilter,
    positionFilter,
    query,
    regionFilter,
    statusFilter,
  ].filter(Boolean).length;

  function clearFilters() {
    setAreaFilter("");
    setDepartmentFilter("");
    setLineFilter("");
    setManagerFilter("");
    setPositionFilter("");
    setQuery("");
    setRegionFilter("");
    setStatusFilter("");
  }

  function exportCsv() {
    const headers = [
      "vacancy",
      "position",
      "department",
      "line",
      "region",
      "area",
      "manager",
      "manager_hr_id",
      "source_row",
      "status",
      "created_at",
    ];
    const rows = filteredRows.map((row) => [
      vacancyLabel(row.vacancyCode),
      row.positionTitle ?? row.jobTitle,
      row.departmentName,
      row.lineName,
      row.regionName,
      row.areaName,
      row.managerName,
      row.managerHrId,
      row.sourceRowNumber,
      row.status,
      row.createdAt,
    ]);
    const csv = [
      headers.map(csvCell).join(","),
      ...rows.map((row) => row.map(csvCell).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "phoenix-vacancies-report.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card className="overflow-hidden border-slate-200 bg-white p-0 shadow-[0_20px_50px_rgba(15,23,42,0.06)]">
      <div className="border-b border-slate-200 bg-slate-950 px-5 py-5 text-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-orange-300">
              Workforce Reports
            </p>
            <h1 className="mt-2 text-2xl font-bold">Vacancies Report</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-300">
              Open positions recorded from employee master data rows without HR_ID, grouped by the Phoenix organization structure.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">
              {report ? `${filteredRows.length} visible` : "No data"}
            </Badge>
            <Button
              className="border-white/15 bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/15"
              disabled={!report || filteredRows.length === 0}
              onClick={exportCsv}
              variant="secondary"
            >
              <Download className="mr-2 h-3.5 w-3.5" />
              Export CSV
            </Button>
            <Button
              className="border-white/15 bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/15"
              disabled={isLoading}
              onClick={() => void loadReport()}
              variant="secondary"
            >
              {isLoading ? <LoadingSpinner /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5">

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
            <div>
              <h2 className="text-base font-semibold text-text">
                Vacancy report unavailable
              </h2>
              <p className="mt-1 text-sm text-text-secondary">{error}</p>
            </div>
          </div>
        </div>
      ) : null}

      {isLoading && !report ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center gap-3 text-sm text-text-secondary">
            <LoadingSpinner />
            Loading vacancies...
          </div>
        </div>
      ) : null}

      {report ? (
        <>
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              label="Open Vacancies"
              tone="warning"
              value={filteredSummary.openVacancies}
            />
            <SummaryCard
              label="Lines Affected"
              tone="neutral"
              value={filteredSummary.linesAffected}
            />
            <SummaryCard
              label="Areas Affected"
              tone="neutral"
              value={filteredSummary.areasAffected}
            />
            <SummaryCard
              label="Positions Affected"
              tone="neutral"
              value={filteredSummary.positionsAffected}
            />
          </section>

          <section className="grid gap-3 xl:grid-cols-3">
            <MiniBreakdown
              icon={<Layers3 className="h-5 w-5" />}
              items={breakdowns.regions}
              title="Region Breakdown"
            />
            <MiniBreakdown
              icon={<BriefcaseBusiness className="h-5 w-5" />}
              items={breakdowns.lines}
              title="Line Breakdown"
            />
            <MiniBreakdown
              icon={<UsersRound className="h-5 w-5" />}
              items={breakdowns.managers}
              title="Manager Breakdown"
            />
          </section>

          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="flex flex-col gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-base font-semibold text-text">
                  Vacancy Records
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Showing {filteredRows.length} of{" "}
                  {report.summary.totalVacancies} vacancy records.
                </p>
              </div>
              <div className="flex items-center gap-2 text-primary">
                <Building2 className="h-5 w-5" />
                <Badge variant="warning">{filteredRows.length} visible</Badge>
              </div>
            </div>

            <div className="grid gap-3 border-b border-slate-200 bg-white p-4 xl:grid-cols-[1.6fr_repeat(7,minmax(0,1fr))_auto]">
              <label className="relative block">
                <span className="sr-only">Search vacancies</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
                <Input
                  className="bg-white pl-9"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search vacancy, area, line, position..."
                  value={query}
                />
              </label>
              <SelectFilter
                label="Department"
                onChange={setDepartmentFilter}
                options={filterOptions.departments}
                value={departmentFilter}
              />
              <SelectFilter
                label="Line"
                onChange={setLineFilter}
                options={filterOptions.lines}
                value={lineFilter}
              />
              <SelectFilter
                label="Area"
                onChange={setAreaFilter}
                options={filterOptions.areas}
                value={areaFilter}
              />
              <SelectFilter
                label="Region"
                onChange={setRegionFilter}
                options={filterOptions.regions}
                value={regionFilter}
              />
              <SelectFilter
                label="Manager"
                onChange={setManagerFilter}
                options={filterOptions.managers}
                value={managerFilter}
              />
              <SelectFilter
                label="Position"
                onChange={setPositionFilter}
                options={filterOptions.positions}
                value={positionFilter}
              />
              <SelectFilter
                label="Status"
                onChange={setStatusFilter}
                options={filterOptions.statuses}
                value={statusFilter}
              />
              <Button
                className="gap-2 whitespace-nowrap"
                disabled={!hasActiveFilters}
                onClick={clearFilters}
                variant="secondary"
              >
                <X className="h-4 w-4" />
                Clear {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
              </Button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[1150px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-100 text-xs uppercase tracking-[0.12em] text-text-secondary">
                    <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Vacancy</th>
                    <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Position</th>
                    <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Department</th>
                    <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Line</th>
                    <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Region</th>
                    <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Area</th>
                    <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Manager</th>
                    <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Source</th>
                    <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td
                        className="px-4 py-10 text-center text-sm text-text-secondary"
                        colSpan={9}
                      >
                        No vacancies match the current filters.
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((row) => (
                      <tr
                        className="transition-colors hover:bg-slate-50"
                        key={row.id}
                      >
                        <td className="px-4 py-4">
                          <p className="font-mono text-xs font-bold text-text">
                            {vacancyLabel(row.vacancyCode)}
                          </p>
                          <p className="mt-1 text-xs text-text-secondary">
                            Source row {emptyText(row.sourceRowNumber)}
                          </p>
                        </td>
                        <td className="px-4 py-4 text-text">
                          {emptyText(row.positionTitle ?? row.jobTitle)}
                        </td>
                        <td className="px-4 py-4 text-text-secondary">
                          {emptyText(row.departmentName)}
                        </td>
                        <td className="px-4 py-4 text-text-secondary">
                          {emptyText(row.lineName)}
                        </td>
                        <td className="px-4 py-4 text-text-secondary">
                          {emptyText(row.regionName)}
                        </td>
                        <td className="px-4 py-4 text-text-secondary">
                          {emptyText(row.areaName)}
                        </td>
                        <td className="px-4 py-4">
                          <p className="text-text-secondary">
                            {emptyText(row.managerName)}
                          </p>
                          {row.managerHrId ? (
                            <p className="mt-1 text-xs text-text-secondary">
                              {row.managerHrId}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-4 text-text-secondary">
                          <p>Master data import</p>
                          <p className="mt-1 text-xs text-text-secondary">
                            {formatDate(row.createdAt)}
                          </p>
                        </td>
                        <td className="py-4 pl-4">
                          <Badge
                            variant={row.status === "open" ? "warning" : "neutral"}
                          >
                            {row.status}
                          </Badge>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
      </div>
    </Card>
  );
}
