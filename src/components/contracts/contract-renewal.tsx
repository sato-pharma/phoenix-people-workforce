"use client";

import {
  AlertTriangle,
  Calendar,
  MessageCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import { WhatsAppSendDialog } from "@/components/recruitment/whatsapp-send-dialog";
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
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { daysUntilLifecycleDate, summarizeContractRenewalRows } from "@/lib/lifecycle-risk/metrics";
import type { ContractRenewalDashboardData, ContractRow } from "@/lib/contracts/types";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { phxSelectClassName } from "@/components/ui/form-tokens";


type Props = {
  initialData: ContractRenewalDashboardData | null;
  initialError: string | null;
};

const MONTHS = [
  { label: "January", value: 1 }, { label: "February", value: 2 }, { label: "March", value: 3 },
  { label: "April", value: 4 }, { label: "May", value: 5 }, { label: "June", value: 6 },
  { label: "July", value: 7 }, { label: "August", value: 8 }, { label: "September", value: 9 },
  { label: "October", value: 10 }, { label: "November", value: 11 }, { label: "December", value: 12 },
];
const DUE_WINDOW_70_DAYS = 70;

const ALL = "__all__";
const today = new Date();

const selectClassName  = phxSelectClassName;

const panelClassName =
  "rounded-[20px] border border-slate-200/80 bg-white shadow-[0_16px_44px_rgba(15,23,42,0.06)]";

const tableCellClassName = "px-2 py-1.5 text-xs text-text-secondary";
const tableHeaderClassName = "px-2.5 py-2 text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";

function ContractsPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      <div className={adminPanelClassName}>
        <div className="relative space-y-4">{children}</div>
      </div>
    </div>
  );
}

function daysUntilDate(value: string) {
  return daysUntilLifecycleDate(value) ?? 0;
}

function datePart(value: string, part: "month" | "year") {
  const date = parseDateOnly(value);

  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }

  return part === "month" ? date.getMonth() + 1 : date.getFullYear();
}

function formatStoredDate(value: string | null) {
  return formatDateOnly(value, "en", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

export function ContractRenewal({ initialData, initialError }: Props) {
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;

  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [search, setSearch] = useState("");
  const [lineFilter, setLineFilter] = useState(ALL);
  const [areaFilter, setAreaFilter] = useState(ALL);

  const rows = useMemo(() => initialData?.rows ?? [], [initialData]);

  const filterOptions = useMemo(() => ({
    lines: [...new Set(rows.map((r) => r.line).filter(Boolean))].sort(),
    areas: [...new Set(rows.map((r) => r.area).filter(Boolean))].sort(),
  }), [rows]);

  /** The employee whose WhatsApp dialog is open, or null. One at a time, by row. */
  const [whatsAppRow, setWhatsAppRow] = useState<ContractRow | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (datePart(row.contract_renewal_date, "month") !== selectedMonth) return false;
      if (datePart(row.contract_renewal_date, "year") !== selectedYear) return false;
      const matchSearch = !q || row.full_name.toLowerCase().includes(q) || row.hr_id.toLowerCase().includes(q);
      const matchLine = lineFilter === ALL || row.line === lineFilter;
      const matchArea = areaFilter === ALL || row.area === areaFilter;
      return matchSearch && matchLine && matchArea;
    });
  }, [rows, selectedMonth, selectedYear, search, lineFilter, areaFilter]);

  const summary = useMemo(() => {
    const riskSummary = summarizeContractRenewalRows(filtered.map((row) => ({
      contractRenewalDate: row.contract_renewal_date,
      employeeHrId: row.hr_id,
      employeeName: row.full_name,
      workflowStatus: row.workflow?.status ?? null,
    })));
    return {
      total: riskSummary.totalRenewals,
      upcoming7: riskSummary.dueIn7Days,
      upcoming30: riskSummary.dueIn30Days,
      upcoming70: filtered.filter((row) => {
        const days = daysUntilLifecycleDate(row.contract_renewal_date);
        return days !== null && days >= 0 && days <= DUE_WINDOW_70_DAYS;
      }).length,
    };
  }, [filtered]);

  // Calendar heatmap: count by day-of-month
  const calendarCounts = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const row of rows) {
      if (
        datePart(row.contract_renewal_date, "month") === selectedMonth &&
        datePart(row.contract_renewal_date, "year") === selectedYear
      ) {
        counts[row.renewal_day] = (counts[row.renewal_day] ?? 0) + 1;
      }
    }
    return counts;
  }, [rows, selectedMonth, selectedYear]);
  const maxCount = Math.max(...Object.values(calendarCounts), 1);
  const hasActiveFilters =
    search.trim() ||
    lineFilter !== ALL ||
    areaFilter !== ALL ||
    selectedMonth !== currentMonth ||
    selectedYear !== currentYear;
  const activeFilterCount = [
    search.trim(),
    lineFilter !== ALL ? lineFilter : "",
    areaFilter !== ALL ? areaFilter : "",
    selectedMonth !== currentMonth ? String(selectedMonth) : "",
    selectedYear !== currentYear ? String(selectedYear) : "",
  ].filter(Boolean).length;

  function resetFilters() {
    setSearch("");
    setLineFilter(ALL);
    setAreaFilter(ALL);
    setSelectedMonth(currentMonth);
    setSelectedYear(currentYear);
  }

  if (initialError) {
    return (
      <Card className={`${panelClassName} overflow-hidden p-0`}>
        <AdminPageHero
          badges={
            <div className="flex flex-wrap gap-2">
              <AdminInsightChip>Contract renewals</AdminInsightChip>
            </div>
          }
          description="Track upcoming contract renewals across all employees."
          eyebrow="People Operations"
          icon={<Calendar className="h-3.5 w-3.5" />}
          title="Contract Renewal"
        />
        <div className="p-5">
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-danger" />
            <div>
              <h2 className="text-sm font-semibold text-[#991B1B]">Contract renewal data unavailable</h2>
              <p className="mt-1 text-sm text-[#991B1B]">{initialError}</p>
            </div>
          </AdminCallout>
        </div>
      </Card>
    );
  }

  return (
    <ContractsPageShell>
      {/* ONE dialog for the whole screen, keyed by the row that opened it — not one per row, which
          would mount a copy per employee and have each fetch the template list on mount. */}
      {whatsAppRow ? (
        <WhatsAppSendDialog
          employeeHrId={whatsAppRow.hr_id}
          employeeName={whatsAppRow.full_name}
          onClose={() => setWhatsAppRow(null)}
        />
      ) : null}
      <AdminPageHero
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button className="h-8 rounded-lg px-3 py-0 text-phx-xs" variant="secondary">
              {summary.upcoming30} due in 30 days
            </Button>
            <Button className="h-8 rounded-lg px-3 py-0 text-phx-xs" variant="secondary">
              {summary.upcoming70} due in 70 days
            </Button>
            <Button
              className="h-9 gap-2 rounded-xl"
              disabled={!hasActiveFilters}
              onClick={resetFilters}
              variant="secondary"
            >
              <RefreshCw className="h-4 w-4" />
              Reset {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
            </Button>
          </div>
        }
        compact
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>{summary.total} renewals</AdminInsightChip>
            <AdminInsightChip tone="slate">{summary.upcoming30} due in 30d</AdminInsightChip>
            <AdminInsightChip tone="slate">{summary.upcoming7} due in 7d</AdminInsightChip>
            <AdminInsightChip tone="slate">{summary.upcoming70} due in 70d</AdminInsightChip>
          </div>
        }
        description="Track annual contract renewals from active contracts or the next valid hire-date anniversary."
        eyebrow="People Operations"
        icon={<Calendar className="h-3.5 w-3.5" />}
        title="Contract Renewal"
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          size="compact"
          description="Renewals in selected month"
          icon={<Calendar className="h-5 w-5" />}
          label="Total Renewals"
          value={summary.total}
        />
        <AdminStatCard
          size="compact"
          description="Renewal due in 30 days"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Due in 30 Days"
          value={summary.upcoming30}
        />
        <AdminStatCard
          size="compact"
          description="Renewal due in 7 days"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Due in 7 Days"
          value={summary.upcoming7}
        />
        <AdminStatCard
          size="compact"
          description="Renewal due in 70 days"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Due in 70 Days"
          value={summary.upcoming70}
        />
      </div>

      <Card className={`${panelClassName} p-4`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-black tracking-[-0.03em] text-phx-ink">Renewal Calendar</h2>
            <p className="mt-1 text-sm text-phx-ink-soft">
              Daily renewal density for {MONTHS.find((m) => m.value === selectedMonth)?.label} {selectedYear}
            </p>
          </div>
          <Badge variant="neutral">
            {MONTHS.find((m) => m.value === selectedMonth)?.label} {selectedYear}
          </Badge>
        </div>
        <div className="grid grid-cols-7 gap-2 sm:grid-cols-10 lg:grid-cols-16">
          {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => {
            const count = calendarCounts[day] ?? 0;
            const intensity = count > 0 ? Math.max(0.2, count / maxCount) : 0;
            return (
              <div
                key={day}
                title={`Day ${day}: ${count} renewal${count !== 1 ? "s" : ""}`}
                className="flex flex-col items-center justify-center rounded-xl border border-phx-line bg-slate-50 py-2 shadow-[0_8px_22px_rgba(15,23,42,0.04)]"
                style={{ backgroundColor: count > 0 ? `rgba(56, 189, 248, ${intensity * 0.26})` : undefined }}
              >
                <span className="text-xs font-mono text-phx-ink-soft">{day}</span>
                {count > 0 && <span className="text-xs font-bold text-[#0284C7]">{count}</span>}
              </div>
            );
          })}
        </div>
      </Card>

      <AdminTableShell
        action={
          <Button
            className="h-9 gap-2 rounded-xl"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
            variant="secondary"
          >
            <RefreshCw className="h-4 w-4" />
            Reset {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
          </Button>
        }
        description="Refine by month, year, line, area, and keyword."
        title="Filters"
        >
        <div className="grid gap-2 p-3 xl:grid-cols-6">
          <label className="block">
            <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Month</span>
            <SearchableSelect
              className={selectClassName}
              value={selectedMonth}
              onChange={(event) => setSelectedMonth(Number(event.target.value))}
            >
              {MONTHS.map((month) => (
                <option key={month.value} value={month.value}>
                  {month.label}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Year</span>
            <SearchableSelect
              className={selectClassName}
              value={selectedYear}
              onChange={(event) => setSelectedYear(Number(event.target.value))}
            >
              {[-2, -1, 0, 1, 2].map((offset) => (
                <option key={offset} value={currentYear + offset}>
                  {currentYear + offset}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <label className="relative block">
            <span className="sr-only">Search renewals</span>
            <Search className="pointer-events-none absolute left-3 top-9 h-4 w-4 text-phx-ink-soft" />
            <Input
              className="pl-9"
              placeholder="Search name or HR ID"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Line</span>
            <SearchableSelect
              className={selectClassName}
              value={lineFilter}
              onChange={(event) => setLineFilter(event.target.value)}
            >
              <option value={ALL}>All lines</option>
              {filterOptions.lines.map((line) => (
                <option key={line} value={line}>
                  {line}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Area</span>
            <SearchableSelect
              className={selectClassName}
              value={areaFilter}
              onChange={(event) => setAreaFilter(event.target.value)}
            >
              <option value={ALL}>All areas</option>
              {filterOptions.areas.map((area) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
            </SearchableSelect>
          </label>
        </div>
      </AdminTableShell>

      <Card className={`${panelClassName} overflow-hidden p-0`}>
        <AdminSectionHeader
          description="Renewal date is sourced from the active contract or the next valid hire-date anniversary."
          title={`Renewals (${filtered.length})`}
          action={
            <div className="flex flex-wrap gap-2">
              <Badge variant={summary.upcoming7 > 0 ? "danger" : "neutral"}>{summary.upcoming7} urgent</Badge>
              <Badge variant="neutral">{filtered.length} visible</Badge>
            </div>
          }
        />
        <PortalResponsiveDataList
          breakpoint="lg"
          items={filtered}
          getKey={(row, index) => `${row.hr_id}-${index}`}
          empty={
            <PortalEmptyState
              title={
                rows.length === 0
                  ? "No hire dates are available to calculate renewals."
                  : "No contract renewals found for this month."
              }
              message="Add employee hire dates to calculate each annual contract renewal automatically."
            />
          }
          renderCard={(row) => {
            const days = daysUntilDate(row.contract_renewal_date);
            const isUrgent = days >= 0 && days <= 7;
            const isWarning = days >= 0 && days <= 30;
            return (
              <PortalRecordCard
                title={row.full_name}
                meta={row.job_title}
                accent={isUrgent ? "rose" : isWarning ? "amber" : "slate"}
                status={
                  days < 0
                    ? <Badge variant="neutral">Past</Badge>
                    : isUrgent
                      ? <Badge variant="danger">{days}d left</Badge>
                      : isWarning
                        ? <Badge variant="warning">{days}d left</Badge>
                        : <Badge variant="neutral">{days}d left</Badge>
                }
              >
                <PortalRecordFields
                  fields={[
                    { label: "Line", value: row.line || "—" },
                    { label: "Area", value: row.area || "—" },
                    { label: "Hire Date", value: formatStoredDate(row.contract_signed_date) },
                    { label: "Renewal Date", value: formatStoredDate(row.contract_renewal_date) },
                  ]}
                />
                {/* Mobile never renders the table, so the action has to exist here too. */}
                <button
                  className="mt-2 inline-flex items-center gap-1.5 text-phx-xs font-semibold text-text-secondary transition hover:text-text"
                  onClick={() => setWhatsAppRow(row)}
                  type="button"
                >
                  <MessageCircle className="h-3.5 w-3.5" />
                  Message on WhatsApp
                </button>
              </PortalRecordCard>
            );
          }}
          renderTable={() => (
            <PortalDesktopTable
              breakpoint="lg"
              className="text-xs"
              cols={
                <colgroup>
                  <col className="w-[32%]" />
                  <col className="w-[14%]" />
                  <col className="w-[14%]" />
                  <col className="w-[12%]" />
                  <col className="w-[14%]" />
                  <col className="w-[14%]" />
                </colgroup>
              }
            >
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/90">
                  {["Employee", "Line", "Area", "Hire Date", "Renewal Date", "Status"].map((col) => (
                    <th className={tableHeaderClassName} key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-phx-line">
                {filtered.map((row, index) => {
                  const days = daysUntilDate(row.contract_renewal_date);
                  const isUrgent = days >= 0 && days <= 7;
                  const isWarning = days >= 0 && days <= 30;
                  return (
                    <tr className="transition-colors hover:bg-slate-50/65" key={`${row.hr_id}-${index}`}>
                      {/*
                        The WhatsApp action lives INSIDE the employee cell rather than in a column of
                        its own. This table is a table-fixed PortalDesktopTable sized to the viewport,
                        so a tenth column would only steal width from the others — and the
                        fits-the-screen rule says fit by MERGING columns, never by adding one.
                      */}
                      <td className={cn(tableCellClassName, "break-words font-semibold text-text")}>
                        <span className="flex items-center gap-1.5">
                          <span>{row.full_name}</span>
                          <button
                            aria-label={`Message ${row.full_name} on WhatsApp`}
                            className="shrink-0 text-text-secondary transition hover:text-text"
                            onClick={() => setWhatsAppRow(row)}
                            title="Message on WhatsApp"
                            type="button"
                          >
                            <MessageCircle className="h-3.5 w-3.5" />
                          </button>
                        </span>
                        <span className="mt-0.5 block break-words font-normal text-text-secondary">{row.job_title}</span>
                      </td>
                      <td className={cn("break-words", tableCellClassName)}>{row.line || "—"}</td>
                      <td className={cn("break-words", tableCellClassName)}>{row.area || "—"}</td>
                      <td className={tableCellClassName}>{formatStoredDate(row.contract_signed_date)}</td>
                      <td className={tableCellClassName}>{formatStoredDate(row.contract_renewal_date)}</td>
                      <td className={tableCellClassName}>
                        {days < 0
                          ? <Badge variant="neutral">Past</Badge>
                          : isUrgent
                            ? <Badge variant="danger">{days}d left</Badge>
                            : isWarning
                              ? <Badge variant="warning">{days}d left</Badge>
                              : <Badge variant="neutral">{days}d left</Badge>
                        }
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </Card>
    </ContractsPageShell>
  );
}
