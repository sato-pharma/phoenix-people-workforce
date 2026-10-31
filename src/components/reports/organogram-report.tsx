"use client";

import {
  AlertCircle,
  Building2,
  Network,
  RefreshCw,
  X,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import * as React from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
  adminSoftPanelClassName,
} from "@/components/admin/admin-design-system";
import { OrgChartTree } from "@/components/organogram/org-chart";
import { OrganogramAsOfPicker } from "@/components/organogram/organogram-as-of";
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
  canAddEmployee?: boolean;
  // Server-decided: may this viewer read a CV (canDownloadEmployeeCv)? False keeps the person
  // popup from probing a CV route that would refuse it. Absent asks the route, as before.
  canReadEmployeeCv?: boolean;
  fixedLine?: string | null;
  initialError?: string | null;
  initialReport?: VacancyReportData | null;
  showHero?: boolean;
};

function OrganogramPageShell({ children }: { children: React.ReactNode }) {
  return <div className="space-y-6">{children}</div>;
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
                  "border px-4 py-2 text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/40",
                  isActive
                    ? "border-phx-accent bg-phx-accent text-white shadow-[0_10px_24px_rgba(249,115,22,0.28)]"
                    : "border-[#D7E0EA] bg-white/95 text-phx-ink shadow-[0_10px_28px_rgba(15,23,42,0.06)] hover:-translate-y-0.5 hover:border-phx-accent-line hover:text-phx-accent-hover hover:shadow-[0_14px_30px_rgba(15,23,42,0.1)]",
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
  asOfMonth = null,
  canAddEmployee = false,
  canReadEmployeeCv = true,
  rows,
  selectedLine,
}: {
  asOfMonth?: string | null;
  canAddEmployee?: boolean;
  canReadEmployeeCv?: boolean;
  rows: OrganogramRow[];
  selectedLine: string | null;
}) {
  return (
    <AdminTableShell
      description="Executive leadership, manager lanes, active employees, and open vacancies in one operational view."
      title={selectedLine ? `${selectedLine} structure` : "Select a line"}
    >
      <div className="p-3 sm:p-4">
        {!selectedLine ? (
          <div className="border border-dashed border-phx-line-strong bg-gradient-to-b from-white to-orange-50/40 p-10 text-center shadow-[0_18px_55px_rgba(15,23,42,0.08)]">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center bg-gradient-to-br from-orange-50 to-orange-100 text-phx-accent shadow-[0_8px_20px_rgba(249,115,22,0.15)] ring-1 ring-orange-200">
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
          <div className="border border-dashed border-phx-line-strong bg-white/90 p-8 text-center text-sm text-phx-ink-soft">
            No rows match the current search or line filter. Clear the search or
            choose another line to reveal the structure.
          </div>
        ) : (
          <OrgChartTree
            asOfMonth={asOfMonth}
            canAddEmployee={canAddEmployee}
            canReadEmployeeCv={canReadEmployeeCv}
            lineName={selectedLine}
            rows={rows}
            theme="admin"
          />
        )}
      </div>
    </AdminTableShell>
  );
}

export function OrganogramReport({
  canAddEmployee = false,
  canReadEmployeeCv = true,
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
  // "View as of": `asOfMonth` is what the picker says, `reportAsOf` is the date the report we
  // are HOLDING was drawn for. They differ only while a fetch is in flight or after it failed, and
  // the chart is always labelled with `reportAsOf` — so a failed pick can never leave a chart of
  // one date under a picker that claims another.
  const [asOfMonth, setAsOfMonth] = React.useState<string | null>(null);
  const [reportAsOf, setReportAsOf] = React.useState<string | null>(null);
  const latestRequest = React.useRef(0);
  // The same date as `reportAsOf`, readable from inside the fetch callback without re-creating it.
  const reportAsOfRef = React.useRef<string | null>(null);
  const searchParams = useSearchParams();
  // Deep-link bootstrap: read once at mount via a lazy initializer, matching
  // how initialReport/initialError are seeded from props. The previous
  // implementation deferred this into a useEffect + setTimeout(0), which
  // both violates the "don't setState synchronously in an effect" rule
  // (effects should sync with external systems, not derive initial state)
  // and doesn't track later URL changes either way — the effect's
  // dependency array never included anything that changes after mount, so
  // this has identical mount-once semantics, just without the anti-pattern.
  const [lineFilter, setLineFilter] = React.useState(() =>
    !fixedLine ? searchParams.get("line")?.trim() ?? "" : "",
  );
  const [organogramSearch, setOrganogramSearch] = React.useState(
    () => searchParams.get("search")?.trim() ?? "",
  );
  const effectiveLineFilter = fixedLine ?? lineFilter;
  const normalizedOrganogramSearch = normalizeSearchValue(organogramSearch);

  const loadReport = React.useCallback(async (month: string | null) => {
    const request = ++latestRequest.current;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        month ? `/api/reports/organogram?asOf=${encodeURIComponent(month)}` : "/api/reports/organogram",
        { cache: "no-store" },
      );
      const payload = await response.json();
      // A newer pick has already gone out: this answer is for a date nobody is looking at.
      if (request !== latestRequest.current) return;

      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "organogram_failed");
        // Put the picker back on the date the chart still shows.
        setAsOfMonth(reportAsOfRef.current);
        return;
      }

      setReport(payload);
      reportAsOfRef.current = month;
      setReportAsOf(month);
    } catch {
      if (request !== latestRequest.current) return;
      setError("Unable to load organogram.");
      setAsOfMonth(reportAsOfRef.current);
    } finally {
      if (request === latestRequest.current) setIsLoading(false);
    }
  }, []);

  function handleAsOfChange(month: string | null) {
    setAsOfMonth(month);
    void loadReport(month);
  }

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
              onClick={() => void loadReport(asOfMonth)}
              variant="secondary"
            >
              {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
          }
          badges={
            <div className="flex flex-wrap gap-2 text-xs text-phx-ink-2">
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
          <div className="flex flex-wrap gap-2 text-xs text-phx-ink-2">
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
            onClick={() => void loadReport(asOfMonth)}
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
        <Card className={cn(adminSoftPanelClassName, "p-4")}>
          <div className="flex items-center gap-3 text-sm text-phx-ink-soft">
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
              {/* Two columns at tablet width, three only from xl: with the status box as a third column it was
                  squeezed to 91px (186px tall) between 768 and about 1100px. Below xl it drops to its own row. */}
              <div className="grid gap-3 md:grid-cols-[minmax(240px,360px)_minmax(200px,260px)] xl:grid-cols-[minmax(240px,360px)_minmax(200px,260px)_1fr]">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                    Search
                  </span>
                  <Input
                    onChange={(event) => setOrganogramSearch(event.target.value)}
                    placeholder="HR ID, employee, manager"
                    value={organogramSearch}
                  />
                </label>
                <OrganogramAsOfPicker
                  disabled={isLoading}
                  labelClassName="text-xs font-medium text-text-secondary"
                  onChange={handleAsOfChange}
                  value={asOfMonth}
                />
                <div className="flex items-end md:col-span-2 xl:col-span-1">
                  <div className="rounded-2xl border border-phx-line bg-white/80 px-4 py-3 text-sm text-text-secondary shadow-[0_12px_36px_rgba(15,23,42,0.06)]">
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
            asOfMonth={reportAsOf}
            canAddEmployee={canAddEmployee}
            canReadEmployeeCv={canReadEmployeeCv}
            rows={canShowChart ? filteredRows : []}
            selectedLine={effectiveLineFilter || (normalizedOrganogramSearch ? "Search results" : null)}
          />
        </>
      ) : null}
    </OrganogramPageShell>
  );
}
