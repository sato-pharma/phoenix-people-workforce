"use client";

import { AlertTriangle, Calendar, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
  AdminSectionHeader,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { daysUntilLifecycleDate, summarizeContractRenewalRows } from "@/lib/lifecycle-risk/metrics";
import type { ContractRenewalDashboardData } from "@/lib/contracts/types";

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

const ALL = "__all__";
const today = new Date();

const selectClassName =
  "h-11 w-full rounded-2xl border border-[#D8E0EA] bg-white/95 px-3 text-sm font-semibold text-[#0F172A] shadow-[0_14px_35px_rgba(15,23,42,0.06)] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15";

const panelClassName =
  "rounded-[28px] border border-white/75 bg-white/94 shadow-[0_28px_90px_rgba(15,23,42,0.12)] ring-1 ring-slate-900/5";

function ContractsPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-[34px] border border-[#FED7AA]/80 bg-[radial-gradient(circle_at_10%_0%,rgba(249,115,22,0.13),transparent_34%),linear-gradient(135deg,#FFF7ED_0%,#F8FAFC_44%,#FFFFFF_100%)] p-4 shadow-[0_30px_110px_rgba(15,23,42,0.11)] sm:p-5">
      <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-[#F97316]/45 to-transparent" />
      <div className="relative space-y-6">{children}</div>
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
      <AdminPageHero
        actions={
          <Button
            className="h-11 gap-2 rounded-2xl"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
            variant="secondary"
          >
            <RefreshCw className="h-4 w-4" />
            Reset {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
          </Button>
        }
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>{summary.total} renewals</AdminInsightChip>
            <AdminInsightChip tone="orange">{summary.upcoming30} due in 30d</AdminInsightChip>
            <AdminInsightChip tone="slate">{summary.upcoming7} due in 7d</AdminInsightChip>
          </div>
        }
        description="Track annual contract renewals from active contracts or the next valid hire-date anniversary."
        eyebrow="People Operations"
        icon={<Calendar className="h-3.5 w-3.5" />}
        title="Contract Renewal"
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          description="Renewals in selected month"
          icon={<Calendar className="h-5 w-5" />}
          label="Total Renewals"
          value={summary.total}
        />
        <AdminStatCard
          description="Renewal due in 30 days"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Due in 30 Days"
          value={summary.upcoming30}
        />
        <AdminStatCard
          description="Renewal due in 7 days"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Due in 7 Days"
          value={summary.upcoming7}
        />
      </div>

      <Card className={`${panelClassName} p-5`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-black tracking-[-0.03em] text-[#0F172A]">Renewal Calendar</h2>
            <p className="mt-1 text-sm text-[#64748B]">
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
                className="flex flex-col items-center justify-center rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] py-2 shadow-[0_10px_26px_rgba(15,23,42,0.04)]"
                style={{ backgroundColor: count > 0 ? `rgba(249, 115, 22, ${intensity * 0.35})` : undefined }}
              >
                <span className="text-xs font-mono text-[#64748B]">{day}</span>
                {count > 0 && <span className="text-xs font-bold text-[#EA580C]">{count}</span>}
              </div>
            );
          })}
        </div>
      </Card>

      <AdminTableShell
        action={
          <Button
            className="h-11 gap-2 rounded-2xl"
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
        <div className="grid gap-3 p-4 xl:grid-cols-6">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Month</span>
            <select
              className={selectClassName}
              value={selectedMonth}
              onChange={(event) => setSelectedMonth(Number(event.target.value))}
            >
              {MONTHS.map((month) => (
                <option key={month.value} value={month.value}>
                  {month.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Year</span>
            <select
              className={selectClassName}
              value={selectedYear}
              onChange={(event) => setSelectedYear(Number(event.target.value))}
            >
              {[-2, -1, 0, 1, 2].map((offset) => (
                <option key={offset} value={currentYear + offset}>
                  {currentYear + offset}
                </option>
              ))}
            </select>
          </label>
          <label className="relative block">
            <span className="sr-only">Search renewals</span>
            <Search className="pointer-events-none absolute left-3 top-9 h-4 w-4 text-[#64748B]" />
            <Input
              className="h-11 rounded-2xl border-[#D8E0EA] bg-white/95 pl-9 shadow-[0_14px_35px_rgba(15,23,42,0.06)]"
              placeholder="Search name or HR ID"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Line</span>
            <select
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
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Area</span>
            <select
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
            </select>
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
        <div className="overflow-x-auto bg-white/80">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-[#FED7AA] bg-[#FFF7ED]/80 text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">
                {["HR ID", "CRM ID", "Full Name", "Job Title", "Line", "Area", "Hire Date", "Renewal Date", "Status"].map((col) => (
                  <th className="px-3 py-3" key={col}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center">
                    <div className="mx-auto max-w-md">
                      <p className="text-sm font-semibold text-[#0F172A]">
                        {rows.length === 0
                          ? "No hire dates are available to calculate renewals."
                          : "No contract renewals found for this month."}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-[#64748B]">
                        Add employee hire dates to calculate each annual contract renewal automatically.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map((row, index) => {
                  const days = daysUntilDate(row.contract_renewal_date);
                  const isUrgent = days >= 0 && days <= 7;
                  const isWarning = days >= 0 && days <= 30;
                  return (
                    <tr className="transition-colors hover:bg-[#FFF7ED]/55" key={`${row.hr_id}-${index}`}>
                      <td className="px-3 py-3 font-mono text-xs text-[#64748B]">{row.hr_id || "-"}</td>
                      <td className="px-3 py-3 font-mono text-xs text-[#64748B]">{row.crm_id || "-"}</td>
                      <td className="px-3 py-3 font-semibold text-[#0F172A]">{row.full_name}</td>
                      <td className="px-3 py-3 text-[#64748B]">{row.job_title}</td>
                      <td className="px-3 py-3 text-[#64748B]">{row.line}</td>
                      <td className="px-3 py-3 text-[#64748B]">{row.area}</td>
                      <td className="px-3 py-3 text-[#64748B]">{formatStoredDate(row.contract_signed_date)}</td>
                      <td className="px-3 py-3 font-medium text-[#0F172A]">{formatStoredDate(row.contract_renewal_date)}</td>
                      <td className="px-3 py-3">
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
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </ContractsPageShell>
  );
}
