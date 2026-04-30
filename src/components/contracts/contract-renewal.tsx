"use client";

import { AlertTriangle, Calendar, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ContractRow } from "@/lib/contracts/types";

type Props = {
  initialData: ContractRow[] | null;
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

function daysUntilDate(value: string) {
  const date = new Date(value);

  return Math.ceil((date.getTime() - today.getTime()) / 86400000);
}

function datePart(value: string, part: "month" | "year") {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return part === "month" ? date.getMonth() + 1 : date.getFullYear();
}

function formatStoredDate(value: string | null) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(date);
}

export function ContractRenewal({ initialData, initialError }: Props) {
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;

  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [search, setSearch] = useState("");
  const [lineFilter, setLineFilter] = useState(ALL);
  const [areaFilter, setAreaFilter] = useState(ALL);

  const rows = useMemo(() => initialData ?? [], [initialData]);

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
    const upcoming7 = filtered.filter((r) => {
      const days = daysUntilDate(r.contract_renewal_date);
      return days >= 0 && days <= 7;
    }).length;
    const upcoming30 = filtered.filter((r) => {
      const days = daysUntilDate(r.contract_renewal_date);
      return days >= 0 && days <= 30;
    }).length;
    return { total: filtered.length, upcoming7, upcoming30 };
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

  if (initialError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-text">Contract Renewal</h1>
          <p className="mt-1 text-text-secondary">Track upcoming contract renewals across all employees.</p>
        </div>
        <Card className="border-danger/20 bg-red-50 dark:bg-red-950/20">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-danger" />
            <p className="text-sm text-danger">{initialError}</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-text">Contract Renewal</h1>
        <p className="mt-1 text-text-secondary">Track annual contract renewals calculated one year after each employee hire date.</p>
      </div>

      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Calendar className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-text-secondary">Total Renewals</p>
              <p className="mt-1 text-2xl font-bold text-text">{summary.total}</p>
              <p className="mt-0.5 text-xs text-text-secondary">This month</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-50 text-warning dark:bg-orange-950/30">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-text-secondary">Due in 30 Days</p>
              <p className="mt-1 text-2xl font-bold text-text">{summary.upcoming30}</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-danger dark:bg-red-950/30">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-text-secondary">Due in 7 Days</p>
              <p className="mt-1 text-2xl font-bold text-text">{summary.upcoming7}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Calendar heatmap */}
      <Card>
        <h2 className="mb-4 text-base font-semibold text-text">Renewal Calendar â€” Day Heatmap</h2>
        <div className="grid grid-cols-7 gap-2 sm:grid-cols-10 lg:grid-cols-16">
          {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => {
            const count = calendarCounts[day] ?? 0;
            const intensity = count > 0 ? Math.max(0.2, count / maxCount) : 0;
            return (
              <div
                key={day}
                title={`Day ${day}: ${count} renewal${count !== 1 ? "s" : ""}`}
                className="flex flex-col items-center justify-center rounded-lg border border-border py-2"
                style={{ backgroundColor: count > 0 ? `rgba(249, 115, 22, ${intensity * 0.4})` : undefined }}
              >
                <span className="text-xs font-mono text-text-secondary">{day}</span>
                {count > 0 && <span className="text-xs font-bold text-warning">{count}</span>}
              </div>
            );
          })}
        </div>
      </Card>

      {/* Filters */}
      <Card>
        <div className="flex flex-wrap gap-3">
          <div className="flex gap-2">
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(Number(e.target.value))}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text focus:outline-none"
            >
              {MONTHS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(Number(e.target.value))}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text focus:outline-none"
            >
              {[-2, -1, 0, 1, 2].map((offset) => (
                <option key={offset} value={currentYear + offset}>{currentYear + offset}</option>
              ))}
            </select>
          </div>
          <Input placeholder="Search name or HR ID" value={search} onChange={(e) => setSearch(e.target.value)} className="w-52" />
          <select
            value={lineFilter}
            onChange={(e) => setLineFilter(e.target.value)}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text focus:outline-none"
          >
            <option value={ALL}>All lines</option>
            {filterOptions.lines.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <select
            value={areaFilter}
            onChange={(e) => setAreaFilter(e.target.value)}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text focus:outline-none"
          >
            <option value={ALL}>All areas</option>
            {filterOptions.areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <Button variant="secondary" onClick={() => { setSearch(""); setLineFilter(ALL); setAreaFilter(ALL); }}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Reset
          </Button>
        </div>
      </Card>

      {/* Table */}
      <Card>
        <div className="mb-4 flex flex-col gap-1">
          <h2 className="text-base font-semibold text-text">Renewals ({filtered.length})</h2>
          <p className="text-sm text-text-secondary">
            Renewal date is calculated from hire date + one year, then repeated annually.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[900px] w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                {["HR ID", "CRM ID", "Full Name", "Job Title", "Line", "Area", "Hire Date", "Renewal Date", "Status"].map((col) => (
                  <th key={col} className="pb-3 pr-4 font-medium text-text-secondary">{col}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-10 text-center">
                    <div className="mx-auto max-w-md">
                      <p className="text-sm font-semibold text-text">
                        {rows.length === 0
                          ? "No hire dates are available to calculate renewals."
                          : "No contract renewals found for this month."}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-text-secondary">
                        Add employee hire dates to calculate each annual contract
                        renewal automatically.
                      </p>
                    </div>
                  </td>
                </tr>
              )}
              {filtered.map((row, i) => {
                const days = daysUntilDate(row.contract_renewal_date);
                const isUrgent = days >= 0 && days <= 7;
                const isWarning = days >= 0 && days <= 30;
                return (
                  <tr key={`${row.hr_id}-${i}`} className="hover:bg-bg-muted transition-colors">
                    <td className="py-3 pr-4 font-mono text-xs text-text-secondary">{row.hr_id || "â€”"}</td>
                    <td className="py-3 pr-4 font-mono text-xs text-text-secondary">{row.crm_id || "â€”"}</td>
                    <td className="py-3 pr-4 font-semibold text-text">{row.full_name}</td>
                    <td className="py-3 pr-4 text-text-secondary">{row.job_title}</td>
                    <td className="py-3 pr-4 text-text-secondary">{row.line}</td>
                    <td className="py-3 pr-4 text-text-secondary">{row.area}</td>
                    <td className="py-3 pr-4 text-text-secondary">{formatStoredDate(row.contract_signed_date)}</td>
                    <td className="py-3 pr-4 font-medium text-text">{formatStoredDate(row.contract_renewal_date)}</td>
                    <td className="py-3">
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
          </table>
        </div>
      </Card>
    </div>
  );
}
