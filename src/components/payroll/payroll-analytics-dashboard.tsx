"use client";

import {
  AlertTriangle,
  Banknote,
  BarChart3,
  FileSpreadsheet,
  Landmark,
  Receipt,
  Search,
  TrendingUp,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCurrencyValue, formatNumberValue } from "@/lib/i18n/format";
import type { PayrollDashboardData, SalaryRecord } from "@/lib/payroll/types";
import { cn } from "@/lib/utils";

type Props = {
  initialData: PayrollDashboardData | null;
  initialError: string | null;
  portalMode?: boolean;
};

type GroupRow = {
  additions: number;
  deductions: number;
  employees: number;
  gross: number;
  key: string;
  net: number;
};

function formatEGP(value: number) {
  return formatCurrencyValue(value);
}

function formatNumber(value: number) {
  return formatNumberValue(value);
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function monthLabel(month?: number, year?: number) {
  if (!month || !year) return "No payroll batch";
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[month - 1] ?? month} ${year}`;
}

function sum(records: SalaryRecord[], key: keyof SalaryRecord) {
  return records.reduce((total, record) => total + Number(record[key] ?? 0), 0);
}

function normalizedText(value: string) {
  return value.toLowerCase().replace(/[\s._-]+/g, "");
}

function isRealArea(value: string) {
  const normalized = normalizedText(value);
  if (!normalized) return false;

  return normalized !== "egypt" && normalized !== "headoffice" && normalized !== "headquarter" && normalized !== "hq";
}

function uniqueSorted(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function groupBy(records: SalaryRecord[], key: "line" | "area" | "jobTitle") {
  const map = new Map<string, GroupRow>();

  records.forEach((record) => {
    const label = String(record[key] || "Unassigned");
    const current = map.get(label) ?? {
      additions: 0,
      deductions: 0,
      employees: 0,
      gross: 0,
      key: label,
      net: 0,
    };

    current.additions += record.totalAdditions;
    current.deductions += record.totalDeductions;
    current.employees += 1;
    current.gross += record.grossSalary;
    current.net += record.netSalary;
    map.set(label, current);
  });

  return Array.from(map.values()).sort((left, right) => right.net - left.net);
}

function filterRecords(records: SalaryRecord[], filters: { area: string; jobTitle: string; line: string; search: string }) {
  const search = filters.search.trim().toLowerCase();

  return records.filter((record) => {
    const searchable = [
      record.hrId,
      record.fullName,
      record.line,
      record.area,
      record.jobTitle,
    ].join(" ").toLowerCase();

    return (
      (!filters.line || record.line === filters.line) &&
      (!filters.area || record.area === filters.area) &&
      (!filters.jobTitle || record.jobTitle === filters.jobTitle) &&
      (!search || searchable.includes(search))
    );
  });
}

function StatCard({
  icon: Icon,
  label,
  sub,
  tone = "orange",
  value,
}: {
  icon: typeof Banknote;
  label: string;
  sub: string;
  tone?: "orange" | "green" | "red" | "slate";
  value: string;
}) {
  const tones = {
    green: "bg-emerald-50 text-emerald-700 ring-emerald-100",
    orange: "bg-orange-50 text-orange-700 ring-orange-100",
    red: "bg-rose-50 text-rose-700 ring-rose-100",
    slate: "bg-slate-100 text-slate-800 ring-slate-200",
  };

  return (
    <Card className="overflow-hidden rounded-xl border-slate-200 bg-white p-0 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
      <div className="h-1 bg-gradient-to-r from-orange-500 to-slate-900" />
      <div className="flex items-center gap-4 p-5">
        <span className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ring-1", tones[tone])}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">{label}</p>
          <p className="mt-1 truncate text-2xl font-black text-slate-950">{value}</p>
          <p className="mt-1 text-xs font-medium text-slate-500">{sub}</p>
        </div>
      </div>
    </Card>
  );
}

function BarRows({ rows, title }: { rows: GroupRow[]; title: string }) {
  const max = Math.max(...rows.map((row) => row.net), 1);

  return (
    <Card className="rounded-xl border-slate-200 bg-white p-5 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
      <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-950">{title}</h2>
      <div className="mt-4 space-y-3">
        {rows.slice(0, 8).map((row, index) => (
          <div className="grid grid-cols-[24px_minmax(0,1fr)_100px] items-center gap-3" key={row.key}>
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-100 text-xs font-black text-slate-600">
              {index + 1}
            </span>
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-sm font-bold text-slate-900">{row.key}</p>
                <p className="shrink-0 text-[11px] font-semibold text-slate-500">{formatNumber(row.employees)} employees</p>
              </div>
              <div className="mt-1.5 h-2 rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-orange-500" style={{ width: `${Math.min((row.net / max) * 100, 100)}%` }} />
              </div>
            </div>
            <p className="text-right text-xs font-black text-slate-700">{formatEGP(row.net).replace("EGP", "")}</p>
          </div>
        ))}
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
      <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</span>
      <select
        className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function LineComparisonChart({ rows }: { rows: GroupRow[] }) {
  const topRows = rows.slice(0, 8);
  const max = Math.max(...topRows.map((row) => row.gross), 1);

  return (
    <Card className="rounded-xl border-slate-200 bg-white p-5 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-950">Line Payroll Comparison</h2>
          <p className="mt-1 text-xs text-slate-500">Visual comparison between lines by gross, net, additions, and deductions.</p>
        </div>
        <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-bold text-orange-700">{formatNumber(rows.length)} lines</span>
      </div>
      <div className="mt-5 space-y-5">
        {topRows.length === 0 ? (
          <p className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">No line data for the current filters.</p>
        ) : (
          topRows.map((row) => {
            const grossWidth = Math.min((row.gross / max) * 100, 100);
            const netWidth = Math.min((row.net / max) * 100, 100);
            const additionsWidth = Math.min((row.additions / max) * 100, 100);
            const deductionsWidth = Math.min((row.deductions / max) * 100, 100);

            return (
              <div className="grid gap-2" key={row.key}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-slate-950">{row.key}</p>
                    <p className="text-[11px] font-semibold text-slate-500">{formatNumber(row.employees)} employees</p>
                  </div>
                  <p className="shrink-0 text-sm font-black text-orange-600">{formatEGP(row.net)}</p>
                </div>
                <div className="grid gap-1.5">
                  <div className="h-2.5 rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-slate-900" style={{ width: `${grossWidth}%` }} />
                  </div>
                  <div className="h-2.5 rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-orange-500" style={{ width: `${netWidth}%` }} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="h-1.5 rounded-full bg-emerald-50">
                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${additionsWidth}%` }} />
                    </div>
                    <div className="h-1.5 rounded-full bg-rose-50">
                      <div className="h-full rounded-full bg-rose-500" style={{ width: `${deductionsWidth}%` }} />
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 text-[11px] font-semibold text-slate-500">
                  <span>Gross {formatEGP(row.gross)}</span>
                  <span>Net {formatEGP(row.net)}</span>
                  <span className="text-emerald-700">Additions {formatEGP(row.additions)}</span>
                  <span className="text-rose-700">Deductions {formatEGP(row.deductions)}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}

function GroupComparison({ rows, title }: { rows: GroupRow[]; title: string }) {
  return (
    <Card className="rounded-xl border-slate-200 bg-white p-5 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
      <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-950">{title}</h2>
      <p className="mt-1 text-xs text-slate-500">Compare employees, gross, additions, deductions, and net payroll.</p>
      <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
        <div className="overflow-x-auto">
          <table className="min-w-[760px] w-full text-left text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="px-3 py-2 font-black">Group</th>
                <th className="px-3 py-2 font-black">Employees</th>
                <th className="px-3 py-2 font-black">Gross</th>
                <th className="px-3 py-2 font-black">Additions</th>
                <th className="px-3 py-2 font-black">Deductions</th>
                <th className="px-3 py-2 font-black">Net</th>
                <th className="px-3 py-2 font-black">Avg Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.slice(0, 20).map((row) => (
                <tr className="hover:bg-slate-50/80" key={row.key}>
                  <td className="max-w-[240px] truncate px-3 py-2 font-bold text-slate-950">{row.key}</td>
                  <td className="px-3 py-2 text-slate-600">{formatNumber(row.employees)}</td>
                  <td className="px-3 py-2 text-slate-600">{formatEGP(row.gross)}</td>
                  <td className="px-3 py-2 text-emerald-700">{formatEGP(row.additions)}</td>
                  <td className="px-3 py-2 text-rose-700">{formatEGP(row.deductions)}</td>
                  <td className="px-3 py-2 font-black text-orange-600">{formatEGP(row.net)}</td>
                  <td className="px-3 py-2 text-slate-600">{formatEGP(row.employees ? row.net / row.employees : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

export function PayrollAnalyticsDashboard({
  initialData,
  initialError,
  portalMode = false,
}: Props) {
  const records = useMemo(() => initialData?.records ?? [], [initialData?.records]);
  const router = useRouter();
  const [filters, setFilters] = useState({ area: "", jobTitle: "", line: "", search: "" });
  const batch = initialData?.batch ?? null;
  const batches = useMemo(() => initialData?.batches ?? [], [initialData?.batches]);
  const flags = initialData?.flags ?? [];
  const filterOptions = useMemo(() => {
    const lineScoped = records.filter((record) => !filters.line || record.line === filters.line);
    const realAreaRows = lineScoped.filter((record) => isRealArea(record.area));
    const areaScoped = lineScoped.filter((record) => !filters.area || record.area === filters.area);

    return {
      areas: uniqueSorted(realAreaRows.map((record) => record.area)),
      jobTitles: uniqueSorted(areaScoped.map((record) => record.jobTitle)),
      lines: uniqueSorted(records.map((record) => record.line)),
    };
  }, [filters.area, filters.line, records]);
  const filteredRecords = useMemo(() => filterRecords(records, filters), [filters, records]);
  const realAreaRecords = useMemo(
    () => filteredRecords.filter((record) => isRealArea(record.area)),
    [filteredRecords],
  );
  const totals = useMemo(() => {
    const net = sum(filteredRecords, "netSalary");
    const employees = filteredRecords.length;

    return {
      additions: sum(filteredRecords, "totalAdditions"),
      avgNet: employees ? net / employees : 0,
      deductions: sum(filteredRecords, "totalDeductions"),
      employees,
      expenses: sum(filteredRecords, "expenses"),
      firstPart: sum(filteredRecords, "firstPart"),
      gross: sum(filteredRecords, "grossSalary"),
      net,
      secondPart: sum(filteredRecords, "secondPart"),
    };
  }, [filteredRecords]);
  const lineRows = useMemo(() => groupBy(filteredRecords, "line"), [filteredRecords]);
  const areaRows = useMemo(() => groupBy(realAreaRecords, "area"), [realAreaRecords]);
  const jobRows = useMemo(() => groupBy(filteredRecords, "jobTitle"), [filteredRecords]);
  const deductionRate = totals.gross ? totals.deductions / totals.gross : 0;
  const activeFilterCount = [filters.area, filters.jobTitle, filters.line, filters.search].filter(Boolean).length;
  const availableYears = useMemo(
    () => [...new Set(batches.map((item) => item.year))].sort((left, right) => right - left),
    [batches],
  );
  const selectedYear = batch?.year ?? availableYears[0] ?? new Date().getFullYear();
  const availableMonths = useMemo(
    () => [...new Set(batches.filter((item) => item.year === selectedYear).map((item) => item.month))].sort((left, right) => left - right),
    [batches, selectedYear],
  );
  const dashboardRoute = portalMode ? "/employee-portals/payroll" : "/payroll/dashboard";

  function changePayrollPeriod(nextMonth: number, nextYear: number) {
    router.push(`${dashboardRoute}?month=${nextMonth}&year=${nextYear}`);
  }

  if (initialError) {
    return (
      <Card className="border-red-200 bg-red-50">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-red-600" />
          <p className="text-sm font-semibold text-red-900">{initialError}</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl border border-slate-900 bg-slate-950 shadow-[0_18px_46px_rgba(15,23,42,0.16)]">
        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_420px] lg:p-6">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-primary">
              {portalMode ? "Employee Payroll" : "Payroll Intelligence"}
            </p>
            <h1 className="mt-2 text-2xl font-black text-white lg:text-3xl">
              {portalMode ? "Salary Dashboard" : "Payroll Dashboard"}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/65">
              {portalMode
                ? "Your latest payroll values, additions, deductions, and salary totals across the periods visible to your employee account."
                : "Executive payroll view for the latest uploaded salary batch, with line, area, job title, additions, deductions, and net salary comparisons."}
            </p>
            {!portalMode && (
              <div className="mt-5 flex flex-wrap gap-2">
                <Link href="/payroll">
                  <Button className="gap-2 border border-white/10 bg-white text-slate-950 hover:bg-white/90">
                    <FileSpreadsheet className="h-4 w-4" />
                    Payroll Report
                  </Button>
                </Link>
                <Link href="/payroll/expenses/dashboard">
                  <Button className="gap-2 border border-white/10 bg-white/10 text-white hover:bg-white/15" variant="secondary">
                    <BarChart3 className="h-4 w-4" />
                    Expenses Dashboard
                  </Button>
                </Link>
              </div>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-white/[0.08] p-4 text-white">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/55">Current Batch</p>
              <p className="mt-1 truncate text-lg font-black">{monthLabel(batch?.month, batch?.year)}</p>
              <p className="mt-2 text-xs text-white/60">{batch?.status ?? "No status"}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.08] p-4 text-white">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/55">Employees</p>
              <p className="mt-1 text-lg font-black">{formatNumber(totals.employees)}</p>
              <p className="mt-2 text-xs text-white/60">{formatNumber(flags.length)} alerts</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.08] p-4 text-white">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/55">Net Payroll</p>
              <p className="mt-1 truncate text-lg font-black">{formatEGP(totals.net)}</p>
              <p className="mt-2 text-xs text-white/60">Avg {formatEGP(totals.avgNet)}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.08] p-4 text-white">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/55">Deduction Rate</p>
              <p className="mt-1 text-lg font-black">{formatPercent(deductionRate)}</p>
              <p className="mt-2 text-xs text-white/60">{formatEGP(totals.deductions)}</p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard icon={Users} label="Employees" sub="Rows in latest payroll" value={formatNumber(totals.employees)} />
        <StatCard icon={Banknote} label="Net Payroll" sub={`Average ${formatEGP(totals.avgNet)}`} tone="green" value={formatEGP(totals.net)} />
        <StatCard icon={TrendingUp} label="Additions" sub={`Expenses ${formatEGP(totals.expenses)}`} tone="green" value={formatEGP(totals.additions)} />
        <StatCard icon={Receipt} label="Deductions" sub={`${formatPercent(deductionRate)} of gross`} tone="red" value={formatEGP(totals.deductions)} />
        <StatCard icon={Landmark} label="Gross Payroll" sub={`First part ${formatEGP(totals.firstPart)}`} tone="slate" value={formatEGP(totals.gross)} />
      </div>

      <Card className="rounded-xl border-slate-200 bg-white p-0 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
        <div className="border-b border-slate-100 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-primary">Advanced Payroll Filters</p>
              <p className="mt-1 text-xs text-slate-500">
                Filter by payroll month/year, line, real area, job title, or employee search. `Egypt` and `Head office` are excluded from area comparisons.
              </p>
            </div>
            {activeFilterCount > 0 && (
              <Button
                className="px-3 py-1.5 text-xs"
                onClick={() => setFilters({ area: "", jobTitle: "", line: "", search: "" })}
                variant="secondary"
              >
                Reset {activeFilterCount}
              </Button>
            )}
          </div>
        </div>
        <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1.4fr]">
          <SelectFilter
            label="Year"
            onChange={(year) => {
              const nextYear = Number(year);
              const fallbackMonth = batches.find((item) => item.year === nextYear)?.month ?? batch?.month ?? 1;
              changePayrollPeriod(fallbackMonth, nextYear);
            }}
            options={availableYears.map(String)}
            value={String(selectedYear)}
          />
          <SelectFilter
            label="Month"
            onChange={(month) => changePayrollPeriod(Number(month), selectedYear)}
            options={availableMonths.map(String)}
            value={String(batch?.month ?? availableMonths[0] ?? "")}
          />
          <SelectFilter
            label="Line"
            onChange={(line) => setFilters((current) => ({ ...current, area: "", jobTitle: "", line }))}
            options={filterOptions.lines}
            value={filters.line}
          />
          <SelectFilter
            label="Area"
            onChange={(area) => setFilters((current) => ({ ...current, area, jobTitle: "" }))}
            options={filterOptions.areas}
            value={filters.area}
          />
          <SelectFilter
            label="Job Title"
            onChange={(jobTitle) => setFilters((current) => ({ ...current, jobTitle }))}
            options={filterOptions.jobTitles}
            value={filters.jobTitle}
          />
        </div>
        <div className="grid gap-4 px-4 pb-4 md:grid-cols-[1.4fr_1fr]">
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">Search</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                placeholder="Employee, HR ID, line, area..."
                value={filters.search}
              />
            </div>
          </label>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">Selected Payroll Period</p>
            <p className="mt-1 text-sm font-black text-slate-950">{monthLabel(batch?.month, batch?.year)}</p>
          </div>
        </div>
      </Card>

      <LineComparisonChart rows={lineRows} />

      <div className="grid gap-5 xl:grid-cols-3">
        <BarRows rows={lineRows} title="Net Payroll by Line" />
        <BarRows rows={areaRows} title="Net Payroll by Real Area" />
        <BarRows rows={jobRows} title="Net Payroll by Job Title" />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <GroupComparison rows={lineRows} title="Line Comparison" />
        <GroupComparison rows={areaRows} title="Real Area Comparison" />
      </div>

      <Card className="rounded-xl border-slate-200 bg-white p-5 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <p className="text-xs text-slate-500">First Part</p>
            <p className="font-bold text-slate-950">{formatEGP(totals.firstPart)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Second Part</p>
            <p className="font-bold text-slate-950">{formatEGP(totals.secondPart)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Payroll Alerts</p>
            <p className="font-bold text-slate-950">{formatNumber(flags.length)}</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
