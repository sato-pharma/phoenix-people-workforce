"use client";

import {
  AlertCircle,
  Building2,
  Network,
  RefreshCw,
  X,
} from "lucide-react";
import * as React from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminSectionHeader,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { OrgChartTree } from "@/components/organogram/org-chart";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { isOrganogramSalesStructureRole } from "@/lib/reports/organogram-safety";
import {
  type OrganogramRow,
  filterOrganogramRows as filterSharedOrganogramRows,
  isOfficeLine as isSharedOfficeLine,
  isOrganogramVisibleRow as isSharedOrganogramVisibleRow,
  isSalesDepartment as isSharedSalesDepartment,
  normalizeSearchValue,
} from "@/lib/reports/organogram-view-model";
import type { VacancyReportData } from "@/lib/reports/vacancies";
import { cn } from "@/lib/utils";


type OrganogramReportProps = {
  fixedLine?: string | null;
  initialError?: string | null;
  initialReport?: VacancyReportData | null;
  showHero?: boolean;
};

const panelClassName =
  "rounded-[28px] border border-white/75 bg-white/94 shadow-[0_28px_90px_rgba(15,23,42,0.12)] ring-1 ring-slate-900/5";

function OrganogramPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-[34px] border border-[#FED7AA]/80 bg-[radial-gradient(circle_at_12%_0%,rgba(249,115,22,0.12),transparent_32%),linear-gradient(135deg,#FFF7ED_0%,#F8FAFC_42%,#FFFFFF_100%)] p-4 shadow-[0_30px_110px_rgba(15,23,42,0.10)] sm:p-5">
      <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-[#F97316]/45 to-transparent" />
      <div className="relative space-y-6">{children}</div>
    </div>
  );
}

function LineButtons({
  onChange,
  options,
  value,
}: {
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-text-secondary">Line</span>
      {options.length === 0 ? (
        <p className="text-sm text-text-secondary">No lines available.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => {
            const isActive = option === value;
            return (
              <button
                aria-pressed={isActive}
                className={cn(
                  "rounded-2xl border px-4 py-2 text-sm font-semibold transition",
                  isActive
                    ? "border-[#F97316] bg-[#F97316] text-white shadow-[0_10px_24px_rgba(249,115,22,0.28)]"
                    : "border-[#D7E0EA] bg-white/95 text-[#0F172A] shadow-[0_10px_28px_rgba(15,23,42,0.06)] hover:border-[#FDBA74] hover:text-[#EA580C]",
                )}
                key={option}
                onClick={() => onChange(isActive ? "" : option)}
                type="button"
              >
                {option}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OrganogramView({
  rows,
  selectedLine,
}: {
  rows: OrganogramRow[];
  selectedLine: string | null;
}) {
  return (
    <Card className={cn(panelClassName, "overflow-hidden p-0")}>
      <AdminSectionHeader
        description="Executive leadership, manager lanes, active employees, and open vacancies in one operational view."
        title={selectedLine ? `${selectedLine} structure` : "Select a line"}
      />
      <div className="p-3 sm:p-4">
        {!selectedLine ? (
          <div className="rounded-3xl border border-dashed border-[#CBD5E1] bg-white/90 p-10 text-center shadow-[0_18px_55px_rgba(15,23,42,0.08)]">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[#F97316]/10 text-[#F97316]">
              <Network className="h-5 w-5" />
            </div>
            <h2 className="text-base font-semibold text-text">
              Select a line to view the organogram
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-text-secondary">
              The hierarchy stays hidden until a line is selected, so the chart
              only shows the exact structure you are reviewing.
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-[#CBD5E1] bg-white/90 p-8 text-center text-sm text-[#64748B]">
            No rows match the current search or line filter. Clear the search or
            choose another line to reveal the structure.
          </div>
        ) : (
          <OrgChartTree lineName={selectedLine} rows={rows} theme="admin" />
        )}
      </div>
    </Card>
  );
}

export function OrganogramReport({
  fixedLine = null,
  initialError = null,
  initialReport = null,
  showHero = true,
}: OrganogramReportProps) {
  const [report, setReport] = React.useState<VacancyReportData | null>(
    initialReport,
  );
  const [error, setError] = React.useState<string | null>(initialError);
  const [isLoading, setIsLoading] = React.useState(false);
  const [lineFilter, setLineFilter] = React.useState("");
  const [organogramSearch, setOrganogramSearch] = React.useState("");
  const effectiveLineFilter = fixedLine ?? lineFilter;
  const normalizedOrganogramSearch = normalizeSearchValue(organogramSearch);

  React.useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const requestedLine = params.get("line")?.trim();
      const requestedSearch = params.get("search")?.trim();

      if (!fixedLine && requestedLine) {
        setLineFilter(requestedLine);
      }
      if (requestedSearch) {
        setOrganogramSearch(requestedSearch);
      }
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [fixedLine]);

  const loadReport = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/reports/organogram", {
        cache: "no-store",
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "organogram_failed");
        return;
      }

      setReport(payload);
    } catch {
      setError("Unable to load organogram.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const rows = React.useMemo(
    () =>
      (report?.organogramRows ?? []).filter(
        (row) => isSharedOrganogramVisibleRow(row),
      ),
    [report],
  );
  const lineOptions = React.useMemo(() => {
    const options = new Set<string>();

    for (const row of rows) {
      if (!row.lineName) {
        continue;
      }

      if (isSharedSalesDepartment(row) || isSharedOfficeLine(row) || isOrganogramSalesStructureRole(row)) {
        options.add(row.lineName);
      }
    }

    return Array.from(options).sort((a, b) => a.localeCompare(b));
  }, [rows]);
  const filterOptions = React.useMemo(
    () => ({
      lines: lineOptions,
    }),
    [lineOptions],
  );
  const filteredRows = React.useMemo(() => {
    return filterSharedOrganogramRows(
      rows,
      effectiveLineFilter,
      normalizedOrganogramSearch,
    );
  }, [effectiveLineFilter, normalizedOrganogramSearch, rows]);
  const hasActiveFilters = (Boolean(effectiveLineFilter) && !fixedLine) || Boolean(normalizedOrganogramSearch);
  const canShowChart = Boolean(effectiveLineFilter || normalizedOrganogramSearch);

  function clearFilters() {
    setLineFilter("");
    setOrganogramSearch("");
  }

  return (
    <OrganogramPageShell>
      {showHero ? (
        <AdminPageHero
          actions={
            <Button
              className="h-11 rounded-2xl px-4 text-xs"
              disabled={isLoading}
              onClick={() => void loadReport()}
              variant="secondary"
            >
              {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
          }
          badges={
            <div className="flex flex-wrap gap-2 text-xs text-[#475569]">
              <AdminInsightChip>
                {effectiveLineFilter ? `${effectiveLineFilter} selected` : "Select line"}
              </AdminInsightChip>
              <AdminInsightChip tone="orange">
                {rows.length} total rows cached
              </AdminInsightChip>
            </div>
          }
          description="Sales lines show Sales and Marketing leadership. Office shows the full office structure."
          eyebrow="People"
          icon={<Building2 className="h-3.5 w-3.5" />}
          title="Organogram"
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-white/75 bg-white/90 px-4 py-3 shadow-[0_18px_48px_rgba(15,23,42,0.07)]">
          <div className="flex flex-wrap gap-2 text-xs text-[#475569]">
            <AdminInsightChip>
              {effectiveLineFilter ? `${effectiveLineFilter} selected` : "Select line"}
            </AdminInsightChip>
            <AdminInsightChip tone="orange">
              {rows.length} total rows cached
            </AdminInsightChip>
          </div>
          <Button
            className="h-11 rounded-2xl px-4 text-xs"
            disabled={isLoading}
            onClick={() => void loadReport()}
            variant="secondary"
          >
            {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>
      )}

      {error ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
          <div>
            <h2 className="text-base font-semibold text-text">Organogram unavailable</h2>
            <p className="mt-1 text-sm text-text-secondary">{error}</p>
          </div>
        </AdminCallout>
      ) : null}

      {isLoading && !report ? (
        <Card className={`${panelClassName} p-4`}>
          <div className="flex items-center gap-3 text-sm text-[#64748B]">
            <LoadingSpinner />
            Loading organogram...
          </div>
        </Card>
      ) : null}

      {report ? (
        <>
          <AdminTableShell
            action={
              !fixedLine ? (
                <Button
                  className="h-11 gap-2 rounded-2xl"
                  disabled={!hasActiveFilters}
                  onClick={clearFilters}
                  variant="secondary"
                >
                  <X className="h-4 w-4" />
                  Reset
                </Button>
              ) : null
            }
            description="Select a line to reveal the matching hierarchy."
            title="Hierarchy Scope"
          >
            <div className="space-y-4 p-4">
              {!fixedLine ? (
                <LineButtons
                  onChange={setLineFilter}
                  options={filterOptions.lines}
                  value={lineFilter}
                />
              ) : null}
              <div className="grid gap-3 md:grid-cols-[minmax(240px,360px)_1fr]">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                    Search
                  </span>
                  <Input
                    className="h-11 rounded-2xl border-[#D7E0EA] bg-white/95 text-sm font-semibold text-[#0F172A] shadow-[0_14px_35px_rgba(15,23,42,0.06)] focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                    onChange={(event) => setOrganogramSearch(event.target.value)}
                    placeholder="HR ID, employee, manager"
                    value={organogramSearch}
                  />
                </label>
                <div className="flex items-end">
                  <div className="rounded-2xl border border-[#E2E8F0] bg-white/80 px-4 py-3 text-sm text-text-secondary shadow-[0_12px_36px_rgba(15,23,42,0.06)]">
                    {normalizedOrganogramSearch
                      ? `Showing ${filteredRows.length} matching rows.`
                      : effectiveLineFilter
                      ? `Showing ${filteredRows.length} rows inside ${effectiveLineFilter}.`
                      : "Pick a line to render the hierarchy in one focused view."}
                  </div>
                </div>
              </div>
            </div>
          </AdminTableShell>

          <OrganogramView
            rows={canShowChart ? filteredRows : []}
            selectedLine={effectiveLineFilter || (normalizedOrganogramSearch ? "Search results" : null)}
          />
        </>
      ) : null}
    </OrganogramPageShell>
  );
}
