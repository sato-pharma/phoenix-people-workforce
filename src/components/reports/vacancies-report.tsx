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

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminSectionHeader,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { formatDateOnly } from "@/lib/date-only";
import { publicVacancyLabel } from "@/lib/reports/organogram-safety";
import type { VacancyReportData } from "@/lib/reports/vacancies";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";


type VacanciesReportProps = {
  initialError?: string | null;
  initialReport?: VacancyReportData | null;
};

const panelClassName =
  "rounded-[28px] border border-phx-line bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";

function VacanciesReportShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative isolate min-h-[calc(100vh-8rem)] overflow-hidden rounded-[34px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_32%),linear-gradient(135deg,#FFF9F3_0%,#FFFFFF_44%,#F7FAFC_100%)] p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-phx-accent/12 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-10 left-1/4 h-64 w-64 rounded-full bg-phx-ink/6 blur-3xl"
      />
      <div className="relative z-10 space-y-6">{children}</div>
    </div>
  );
}

function emptyText(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function vacancyLabel(vacancyCode: string) {
  return publicVacancyLabel(vacancyCode);
}

function uniqueOptions(values: Array<string | null>) {
  return Array.from(new Set(values.filter(Boolean) as string[])).sort((a, b) =>
    a.localeCompare(b),
  );
}

function formatDate(value: string | null | undefined) {
  return formatDateOnly(value, "en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
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

function BreakdownPanel({
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
    <Card className={`${panelClassName} p-5 transition-transform duration-200 hover:-translate-y-0.5`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">
            {title}
          </p>
          <p className="mt-1 text-sm text-phx-ink-soft">Top groups by visible vacancies.</p>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-phx-accent-soft text-phx-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
          {icon}
        </div>
      </div>

      <div className="mt-5 space-y-3">
        {topItems.length === 0 ? (
          <p className="text-sm text-phx-ink-soft">No data available.</p>
        ) : (
          topItems.map((item) => {
            const width = total > 0 ? `${Math.max((item.count / total) * 100, 6)}%` : "0%";

            return (
              <div key={item.name}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-medium text-phx-ink">{item.name}</span>
                  <span className="text-phx-ink-soft">{item.count}</span>
                </div>
                <div className="mt-2 h-2 rounded-full bg-phx-line shadow-inner">
                  <div
                    className="h-2 rounded-full bg-gradient-to-r from-phx-accent to-phx-accent-line"
                    style={{ width }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </Card>
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
      <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">
        {label}
      </span>
      <SearchableSelect
        className="h-11 w-full rounded-2xl border border-[#D7E0EA] bg-white/95 px-3 text-sm font-semibold text-phx-ink shadow-sm outline-none transition focus:border-phx-accent-line focus:ring-2 focus:ring-phx-accent/12"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">All {label}s</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </SearchableSelect>
    </label>
  );
}

export function VacanciesReport({
  initialError = null,
  initialReport = null,
}: VacanciesReportProps) {
  const [report, setReport] = React.useState<VacancyReportData | null>(initialReport);
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
      positions: uniqueOptions(rows.map((row) => row.positionTitle ?? row.jobTitle)),
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
      positionsAffected: uniqueOptions(openRows.map((row) => row.positionTitle ?? row.jobTitle)).length,
      totalVacancies: filteredRows.length,
    };
  }, [filteredRows]);

  const breakdowns = React.useMemo(
    () => ({
      lines: groupCounts(filteredRows, (row) => row.lineName),
      managers: groupCounts(filteredRows, (row) => row.managerName),
      regions: groupCounts(filteredRows, (row) => row.regionName),
      departments: groupCounts(filteredRows, (row) => row.departmentName),
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
    <VacanciesReportShell>
    <div className="space-y-6">
      <AdminPageHero
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              className="rounded-2xl px-3 py-2 text-xs shadow-sm"
              disabled={!report || filteredRows.length === 0}
              onClick={exportCsv}
              variant="secondary"
            >
              <Download className="mr-2 h-3.5 w-3.5" />
              Export CSV
            </Button>
            <Button
              className="rounded-2xl px-3 py-2 text-xs shadow-sm"
              disabled={isLoading}
              onClick={() => void loadReport()}
              variant="secondary"
            >
              {isLoading ? <LoadingSpinner /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        }
        description="Open positions sourced from employee master records without HR_ID. Inspect vacancies by area, line, manager, and status, then export filtered extracts."
        eyebrow="Workforce Reports"
        icon={<Building2 className="h-3.5 w-3.5" />}
        title="Vacancies Report"
        badges={
          <div className="flex flex-wrap gap-2 text-xs">
            <AdminInsightChip>Total: {filteredSummary.totalVacancies}</AdminInsightChip>
            <AdminInsightChip tone="orange">Open: {filteredSummary.openVacancies}</AdminInsightChip>
            <AdminInsightChip tone="slate">Lines: {filteredSummary.linesAffected}</AdminInsightChip>
            <AdminInsightChip>Areas: {filteredSummary.areasAffected}</AdminInsightChip>
          </div>
        }
      />

      <AdminTableShell
        description="Narrow to the exact vacancy set you need before reviewing manager, location, and position risk."
        title="Filters"
      >
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-[1.4fr_repeat(4,minmax(0,1fr))]">
          <label className="relative block">
            <span className="sr-only">Search vacancies</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-soft" />
            <Input
              className="h-11 rounded-2xl border-[#D7E0EA] bg-white/95 pl-9 shadow-sm"
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
          <div className="flex items-end">
            <Button
              className="h-11 gap-2 whitespace-nowrap rounded-2xl shadow-sm"
              disabled={!hasActiveFilters}
              onClick={clearFilters}
              variant="secondary"
            >
              <X className="h-4 w-4" />
              Clear {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
            </Button>
          </div>
        </div>
      </AdminTableShell>

      {error ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <h2 className="text-sm font-bold text-[#991B1B]">Vacancy report unavailable</h2>
            <p className="mt-1 text-sm text-[#991B1B]">{error}</p>
          </div>
        </AdminCallout>
      ) : null}

      {isLoading && !report ? (
        <Card className={`${panelClassName} p-4`}>
          <div className="flex items-center gap-3 text-sm text-phx-ink-soft">
            <LoadingSpinner />
            Loading vacancies...
          </div>
        </Card>
      ) : null}

      {report ? (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <AdminStatCard
              description="Vacancies currently marked as open and available"
              icon={<BriefcaseBusiness className="h-5 w-5" />}
              label="Open Vacancies"
              value={filteredSummary.openVacancies}
            />
            <AdminStatCard
              description="Lines that currently have open vacancies"
              icon={<Layers3 className="h-5 w-5" />}
              label="Lines Affected"
              value={filteredSummary.linesAffected}
            />
            <AdminStatCard
              description="Areas reporting open positions"
              icon={<Building2 className="h-5 w-5" />}
              label="Areas Affected"
              value={filteredSummary.areasAffected}
            />
            <AdminStatCard
              description="Distinct positions in the active filter set"
              icon={<UsersRound className="h-5 w-5" />}
              label="Positions Affected"
              value={filteredSummary.positionsAffected}
            />
          </section>

          <section className="grid gap-3 xl:grid-cols-4">
            <BreakdownPanel
              icon={<Building2 className="h-5 w-5" />}
              items={breakdowns.departments}
              title="Department Breakdown"
            />
            <BreakdownPanel
              icon={<UsersRound className="h-5 w-5" />}
              items={breakdowns.managers}
              title="Manager Breakdown"
            />
            <BreakdownPanel
              icon={<Layers3 className="h-5 w-5" />}
              items={breakdowns.lines}
              title="Line Breakdown"
            />
            <BreakdownPanel
              icon={<Building2 className="h-5 w-5" />}
              items={breakdowns.regions}
              title="Region Breakdown"
            />
          </section>

          <Card className={`${panelClassName} overflow-hidden p-0`}>
            <AdminSectionHeader
              action={
                <Badge variant="neutral" className="px-3 py-1 text-xs">
                  {filteredRows.length} visible
                </Badge>
              }
              description={`Showing ${filteredRows.length} of ${report.summary.totalVacancies} vacancy records.`}
              title="Vacancy Records"
            />
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-phx-paper text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">
                  <tr>
                    <th className="px-4 py-3">Vacancy</th>
                    <th className="px-4 py-3">Position</th>
                    <th className="px-4 py-3">Department</th>
                    <th className="px-4 py-3">Line</th>
                    <th className="px-4 py-3">Region</th>
                    <th className="px-4 py-3">Area</th>
                    <th className="px-4 py-3">Manager</th>
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-phx-line">
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td
                        className="px-4 py-10 text-center text-sm text-phx-ink-soft"
                        colSpan={9}
                      >
                        No vacancies match the current filters.
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((row) => (
                      <tr className="transition-colors hover:bg-phx-accent-soft/65" key={row.id}>
                        <td className="px-4 py-4">
                          <p className="font-mono text-xs font-bold text-phx-ink">
                            {vacancyLabel(row.vacancyCode)}
                          </p>
                          <p className="mt-1 text-xs text-phx-ink-soft">
                            Source row {emptyText(row.sourceRowNumber)}
                          </p>
                        </td>
                        <td className="px-4 py-4 text-phx-ink">
                          {emptyText(row.positionTitle ?? row.jobTitle)}
                        </td>
                        <td className="px-4 py-4 text-phx-ink-soft">
                          {emptyText(row.departmentName)}
                        </td>
                        <td className="px-4 py-4 text-phx-ink-soft">
                          {emptyText(row.lineName)}
                        </td>
                        <td className="px-4 py-4 text-phx-ink-soft">
                          {emptyText(row.regionName)}
                        </td>
                        <td className="px-4 py-4 text-phx-ink-soft">
                          {emptyText(row.areaName)}
                        </td>
                        <td className="px-4 py-4">
                          <p className="text-phx-ink-soft">{emptyText(row.managerName)}</p>
                          {row.managerHrId ? (
                            <p className="mt-1 text-xs text-phx-ink-soft">{row.managerHrId}</p>
                          ) : null}
                        </td>
                        <td className="px-4 py-4 text-phx-ink-soft">
                          <p>Master data import</p>
                          <p className="mt-1 text-xs text-phx-ink-soft">{formatDate(row.createdAt)}</p>
                        </td>
                        <td className="px-4 py-4">
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
          </Card>
        </>
      ) : (
        !isLoading &&
        !error &&
        <Card className={`${panelClassName} p-4`}>
          <div className="rounded-2xl border border-phx-line bg-[#FCFDFE] p-4 text-sm text-phx-ink-soft">
            No vacancy report data loaded yet. Use Refresh to request the latest snapshot.
          </div>
        </Card>
      )}
    </div>
    </VacanciesReportShell>
  );
}
