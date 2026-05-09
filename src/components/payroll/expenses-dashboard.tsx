"use client";

import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  Car,
  FileSpreadsheet,
  MapPinned,
  ReceiptText,
  TrendingUp,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCurrencyValue, formatNumberValue } from "@/lib/i18n/format";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import type {
  PayrollExpenseApproval,
  PayrollExpenseReport,
} from "@/lib/payroll/types";
import { cn } from "@/lib/utils";

type Props = {
  initialError: string | null;
  initialEmployees: EmployeeDirectoryRow[];
  initialExpenses: PayrollExpenseApproval[];
  initialReports: PayrollExpenseReport[];
  portalMode?: boolean;
};

type GroupRow = {
  allowance: number;
  count: number;
  key: string;
  km: number;
  meeting: number;
  total: number;
  travel: number;
};

type EnrichedExpense = PayrollExpenseApproval & {
  employeeArea: string;
  employeeLine: string;
  managerHrId: string;
  managerName: string;
};

function valueDate(value: string | null | undefined) {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthKey(value: string) {
  const date = valueDate(value);
  if (!date) return "No Date";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function payoutKey(expense: PayrollExpenseApproval) {
  if (!expense.payoutMonth || !expense.payoutYear) return "Not Scheduled";
  return `${expense.payoutYear}-${String(expense.payoutMonth).padStart(2, "0")}`;
}

function compactMonth(value: string) {
  if (value === "No Date" || value === "Not Scheduled") return value;
  const [year, month] = value.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(month) - 1] ?? month} ${year}`;
}

function formatEGP(value: number) {
  return formatCurrencyValue(value);
}

function formatNumber(value: number) {
  return formatNumberValue(value, "en", { maximumFractionDigits: 1 });
}

function uniqueSorted(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function groupBy<TExpense extends PayrollExpenseApproval>(expenses: TExpense[], getKey: (expense: TExpense) => string) {
  const map = new Map<string, GroupRow>();

  expenses.forEach((expense) => {
    const key = getKey(expense) || "Unassigned";
    const current = map.get(key) ?? {
      allowance: 0,
      count: 0,
      key,
      km: 0,
      meeting: 0,
      total: 0,
      travel: 0,
    };

    current.allowance += expense.allowance;
    current.count += 1;
    current.km += expense.km;
    current.meeting += expense.meetingAmount;
    current.total += expense.total;
    current.travel += expense.travelCost;
    map.set(key, current);
  });

  return Array.from(map.values()).sort((left, right) => right.total - left.total);
}

function normalizeDestination(value: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return "No Destination";

  const normalized = raw
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\b(egypt|eg)\b/gi, "")
    .replace(/\b(governorate|gov\.?|city|markaz|district)\b/gi, "")
    .replace(/محافظه|مدينة|مدينه|مركز|قسم/g, "")
    .replace(/\s*-\s*/g, " ")
    .replace(/[،,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const compact = normalized.toLowerCase();
  const aliases: Array<[RegExp, string]> = [
    [/kafr\s*(el|al)?\s*(sheikh|shaikh)|kafr\s*elsheikh|kafr\s*alshaikh|كفر\s*ال?شيخ|دسوق|desouk|محله\s*زياد|ابو\s*صير|ابوصير/i, "Kafr El Sheikh"],
    [/fai?yum|الفيوم|fayoum/i, "Fayoum"],
    [/al?\s*ayyat|ayat|العياط/i, "Al Ayyat"],
    [/alex|alexandria|اسكندريه|الاسكندريه/i, "Alexandria"],
    [/cairo|القاهره/i, "Cairo"],
    [/giza|الجيزه|جيزه/i, "Giza"],
    [/mansoura|المنصوره/i, "Mansoura"],
    [/tanta|طنطا/i, "Tanta"],
    [/zagazig|الزقازيق/i, "Zagazig"],
    [/ismailia|الاسماعيليه/i, "Ismailia"],
    [/port\s*said|بورسعيد/i, "Port Said"],
    [/domiat|damietta|دمياط/i, "Damietta"],
  ];
  const match = aliases.find(([pattern]) => pattern.test(compact));

  if (match) return match[1];
  return normalized
    .split(" ")
    .slice(0, 5)
    .join(" ");
}

function StatCard({
  icon: Icon,
  label,
  sub,
  tone = "orange",
  value,
}: {
  icon: typeof ReceiptText;
  label: string;
  sub: string;
  tone?: "orange" | "green" | "blue" | "red";
  value: string;
}) {
  const tones = {
    blue: "bg-sky-50 text-sky-700 ring-sky-100",
    green: "bg-emerald-50 text-emerald-700 ring-emerald-100",
    orange: "bg-orange-50 text-orange-700 ring-orange-100",
    red: "bg-red-50 text-red-700 ring-red-100",
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

function BarRows({ rows, title }: { rows: GroupRow[]; title: string }) {
  const max = Math.max(...rows.map((row) => row.total), 1);

  return (
    <Card className="rounded-xl border-slate-200 bg-white p-5 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
      <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-950">{title}</h2>
      <div className="mt-4 space-y-3">
        {rows.slice(0, 8).map((row, index) => (
          <div className="grid grid-cols-[24px_minmax(0,1fr)_86px] items-center gap-3" key={row.key}>
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-100 text-xs font-black text-slate-600">
              {index + 1}
            </span>
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-sm font-bold text-slate-900">{row.key}</p>
                <p className="shrink-0 text-[11px] font-semibold text-slate-500">{formatNumber(row.count)} rows</p>
              </div>
              <div className="mt-1.5 h-2 rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-orange-500" style={{ width: `${Math.min((row.total / max) * 100, 100)}%` }} />
              </div>
            </div>
            <p className="text-right text-xs font-black text-slate-700">{formatEGP(row.total).replace("EGP", "")}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function MonthlyComparison({ rows }: { rows: GroupRow[] }) {
  const max = Math.max(...rows.map((row) => row.total), 1);

  return (
    <Card className="rounded-xl border-slate-200 bg-white p-5 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-950">Monthly Comparison</h2>
          <p className="mt-1 text-xs text-slate-500">Trip month comparison by travel, meetings, allowance, total, and KM.</p>
        </div>
      </div>
      <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
        <div className="overflow-x-auto">
          <table className="min-w-[760px] w-full text-left text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="px-3 py-2 font-black">Month</th>
                <th className="px-3 py-2 font-black">Trips</th>
                <th className="px-3 py-2 font-black">Travel</th>
                <th className="px-3 py-2 font-black">Meeting</th>
                <th className="px-3 py-2 font-black">Allowance</th>
                <th className="px-3 py-2 font-black">Total</th>
                <th className="px-3 py-2 font-black">KM</th>
                <th className="px-3 py-2 font-black">Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map((row) => (
                <tr className="hover:bg-slate-50/80" key={row.key}>
                  <td className="px-3 py-2 font-bold text-slate-950">{compactMonth(row.key)}</td>
                  <td className="px-3 py-2 text-slate-600">{formatNumber(row.count)}</td>
                  <td className="px-3 py-2 text-slate-600">{formatEGP(row.travel)}</td>
                  <td className="px-3 py-2 text-slate-600">{formatEGP(row.meeting)}</td>
                  <td className="px-3 py-2 text-slate-600">{formatEGP(row.allowance)}</td>
                  <td className="px-3 py-2 font-black text-orange-600">{formatEGP(row.total)}</td>
                  <td className="px-3 py-2 text-slate-600">{formatNumber(row.km)}</td>
                  <td className="px-3 py-2">
                    <div className="h-2 w-28 rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-orange-500" style={{ width: `${Math.min((row.total / max) * 100, 100)}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

function SpecialistComparison({ rows }: { rows: GroupRow[] }) {
  return (
    <Card className="rounded-xl border-slate-200 bg-white p-5 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
      <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-950">Specialist Detailed Comparison</h2>
      <p className="mt-1 text-xs text-slate-500">Compare specialists by trips, total, KM, cost per trip, and cost per KM.</p>
      <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
        <div className="overflow-x-auto">
          <table className="min-w-[860px] w-full text-left text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="px-3 py-2 font-black">Specialist</th>
                <th className="px-3 py-2 font-black">Trips</th>
                <th className="px-3 py-2 font-black">Total</th>
                <th className="px-3 py-2 font-black">Travel</th>
                <th className="px-3 py-2 font-black">Meeting</th>
                <th className="px-3 py-2 font-black">Allowance</th>
                <th className="px-3 py-2 font-black">KM</th>
                <th className="px-3 py-2 font-black">Cost / Trip</th>
                <th className="px-3 py-2 font-black">Cost / KM</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.slice(0, 50).map((row) => (
                <tr className="hover:bg-slate-50/80" key={row.key}>
                  <td className="max-w-[220px] truncate px-3 py-2 font-bold text-slate-950">{row.key}</td>
                  <td className="px-3 py-2 text-slate-600">{formatNumber(row.count)}</td>
                  <td className="px-3 py-2 font-black text-orange-600">{formatEGP(row.total)}</td>
                  <td className="px-3 py-2 text-slate-600">{formatEGP(row.travel)}</td>
                  <td className="px-3 py-2 text-slate-600">{formatEGP(row.meeting)}</td>
                  <td className="px-3 py-2 text-slate-600">{formatEGP(row.allowance)}</td>
                  <td className="px-3 py-2 text-slate-600">{formatNumber(row.km)}</td>
                  <td className="px-3 py-2 text-slate-600">{formatEGP(row.count ? row.total / row.count : 0)}</td>
                  <td className="px-3 py-2 text-slate-600">{formatEGP(row.km ? row.total / row.km : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

function DestinationChart({ rows }: { rows: GroupRow[] }) {
  const max = Math.max(...rows.map((row) => row.total), 1);
  const topRows = rows.slice(0, 10);

  return (
    <Card className="rounded-xl border-slate-200 bg-white p-5 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-950">Top Destinations</h2>
          <p className="mt-1 text-xs text-slate-500">Destination names are normalized before comparison. Bars show total cost; side metric shows cost per visit.</p>
        </div>
        <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-bold text-orange-700">
          {formatNumber(rows.length)} destinations
        </span>
      </div>
      <div className="mt-5 space-y-4">
        {topRows.length === 0 ? (
          <p className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">No destination data for the current filters.</p>
        ) : (
          topRows.map((row, index) => {
            const costPerVisit = row.count ? row.total / row.count : 0;
            return (
              <div className="grid gap-2" key={row.key}>
                <div className="grid grid-cols-[28px_minmax(0,1fr)_120px] items-center gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-xs font-black text-slate-600">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-slate-950">{row.key}</p>
                    <p className="text-[11px] font-semibold text-slate-500">
                      {formatNumber(row.count)} visits - {formatNumber(row.km)} KM
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-black text-orange-600">{formatEGP(row.total)}</p>
                    <p className="text-[11px] font-semibold text-slate-500">{formatEGP(costPerVisit)} / visit</p>
                  </div>
                </div>
                <div className="ml-10 h-2.5 rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-gradient-to-r from-orange-500 to-slate-900" style={{ width: `${Math.min((row.total / max) * 100, 100)}%` }} />
                </div>
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}

export function ExpensesDashboard({
  initialEmployees,
  initialError,
  initialExpenses,
  initialReports,
  portalMode = false,
}: Props) {
  const [filters, setFilters] = useState({
    manager: "",
    month: "",
    payout: "",
    reportId: "",
    requestType: "",
    specialist: "",
    status: "",
    transportationType: "",
  });

  const employeesByHrId = useMemo(() => {
    return new Map(initialEmployees.map((employee) => [employee.hrId.toUpperCase(), employee]));
  }, [initialEmployees]);

  const enrichedExpenses = useMemo<EnrichedExpense[]>(() => {
    return initialExpenses.map((expense) => {
      const employee = expense.hrId ? employeesByHrId.get(expense.hrId.toUpperCase()) : undefined;

      return {
        ...expense,
        employeeArea: employee?.areaName ?? "Unassigned Area",
        employeeLine: employee?.lineName ?? "Unassigned Line",
        managerHrId: employee?.managerHrId ?? "",
        managerName: employee?.managerName ?? "Unassigned Manager",
      };
    });
  }, [employeesByHrId, initialExpenses]);

  const options = useMemo(() => ({
    managers: uniqueSorted(enrichedExpenses.map((expense) => expense.managerName)),
    months: uniqueSorted(enrichedExpenses.map((expense) => monthKey(expense.date))),
    payouts: uniqueSorted(enrichedExpenses.map((expense) => payoutKey(expense))),
    requestTypes: uniqueSorted(enrichedExpenses.map((expense) => expense.requestType)),
    specialists: uniqueSorted(enrichedExpenses.map((expense) => expense.specialist)),
    statuses: uniqueSorted(enrichedExpenses.map((expense) => expense.status)),
    transportationTypes: uniqueSorted(enrichedExpenses.map((expense) => expense.transportationType || "No Transportation")),
  }), [enrichedExpenses]);

  const filteredExpenses = useMemo(() => {
    return enrichedExpenses.filter((expense) => {
      const transportation = expense.transportationType || "No Transportation";

      return (
        (!filters.manager || expense.managerName === filters.manager) &&
        (!filters.month || monthKey(expense.date) === filters.month) &&
        (!filters.payout || payoutKey(expense) === filters.payout) &&
        (!filters.reportId || expense.reportId === filters.reportId) &&
        (!filters.requestType || expense.requestType === filters.requestType) &&
        (!filters.specialist || expense.specialist === filters.specialist) &&
        (!filters.status || expense.status === filters.status) &&
        (!filters.transportationType || transportation === filters.transportationType)
      );
    });
  }, [enrichedExpenses, filters]);

  const summary = useMemo(() => {
    const total = filteredExpenses.reduce((sum, expense) => sum + expense.total, 0);
    const approved = filteredExpenses.filter((expense) => expense.hrApproved);
    const km = filteredExpenses.reduce((sum, expense) => sum + expense.km, 0);

    return {
      approvedAmount: approved.reduce((sum, expense) => sum + expense.total, 0),
      approvedRows: approved.length,
      km,
      meeting: filteredExpenses.reduce((sum, expense) => sum + expense.meetingAmount, 0),
      specialists: new Set(filteredExpenses.map((expense) => expense.specialist).filter(Boolean)).size,
      total,
      travel: filteredExpenses.reduce((sum, expense) => sum + expense.travelCost, 0),
      trips: filteredExpenses.length,
    };
  }, [filteredExpenses]);

  const monthlyRows = useMemo(
    () => groupBy(filteredExpenses, (expense) => monthKey(expense.date)).sort((left, right) => left.key.localeCompare(right.key)),
    [filteredExpenses],
  );
  const payoutRows = useMemo(() => groupBy(filteredExpenses, payoutKey), [filteredExpenses]);
  const specialistRows = useMemo(() => groupBy(filteredExpenses, (expense) => expense.specialist), [filteredExpenses]);
  const destinationRows = useMemo(() => groupBy(filteredExpenses, (expense) => normalizeDestination(expense.to || expense.location)), [filteredExpenses]);
  const requestRows = useMemo(() => groupBy(filteredExpenses, (expense) => expense.requestType), [filteredExpenses]);
  const transportRows = useMemo(() => groupBy(filteredExpenses, (expense) => expense.transportationType || "No Transportation"), [filteredExpenses]);
  const statusRows = useMemo(() => groupBy(filteredExpenses, (expense) => expense.status), [filteredExpenses]);

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
              {portalMode ? "Employee Expenses" : "Expense Intelligence"}
            </p>
            <h1 className="mt-2 text-2xl font-black text-white lg:text-3xl">
              {portalMode ? "My Expenses Dashboard" : "Expenses Dashboard"}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/65">
              {portalMode
                ? "Your expense activity by trip month, payout period, request type, transportation, and approval status."
                : "Detailed comparison for uploaded expense sheets by month, payout period, specialist, status, request type, transportation, and cost structure."}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {!portalMode && (
                <Link href="/payroll/expenses">
                  <Button className="gap-2 border border-white/10 bg-white text-slate-950 hover:bg-white/90">
                    <FileSpreadsheet className="h-4 w-4" />
                    Expense Reports
                  </Button>
                </Link>
              )}
              <Button
                className="gap-2 border border-white/10 bg-white/10 text-white hover:bg-white/15"
                onClick={() => setFilters({ manager: "", month: "", payout: "", reportId: "", requestType: "", specialist: "", status: "", transportationType: "" })}
                variant="secondary"
              >
                <BarChart3 className="h-4 w-4" />
                Reset View
              </Button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-white/[0.08] p-4 text-white">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/55">Loaded Reports</p>
              <p className="mt-1 text-lg font-black">{formatNumber(initialReports.length)}</p>
              <p className="mt-2 text-xs text-white/60">{formatNumber(initialExpenses.length)} saved rows</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.08] p-4 text-white">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/55">Filtered Total</p>
              <p className="mt-1 truncate text-lg font-black">{formatEGP(summary.total)}</p>
              <p className="mt-2 text-xs text-white/60">{formatNumber(summary.trips)} trips</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.08] p-4 text-white">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/55">Approved</p>
              <p className="mt-1 truncate text-lg font-black">{formatEGP(summary.approvedAmount)}</p>
              <p className="mt-2 text-xs text-white/60">{formatNumber(summary.approvedRows)} rows approved by HR</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.08] p-4 text-white">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/55">Distance</p>
              <p className="mt-1 text-lg font-black">{formatNumber(summary.km)} KM</p>
              <p className="mt-2 text-xs text-white/60">{summary.km ? formatEGP(summary.total / summary.km) : formatEGP(0)} / KM</p>
            </div>
          </div>
        </div>
      </section>

      <Card className="rounded-xl border-slate-200 bg-white p-0 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-primary">Comparison Filters</p>
          <p className="mt-1 text-xs text-slate-500">Use filters to compare exact months, payout periods, specialists, report files, statuses, and expense types.</p>
        </div>
        <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-4">
          <SelectFilter label="Manager" onChange={(manager) => setFilters((current) => ({ ...current, manager, specialist: "" }))} options={options.managers} value={filters.manager} />
          <SelectFilter label="Trip Month" onChange={(label) => {
            const value = options.months.find((item) => compactMonth(item) === label) ?? "";
            setFilters((current) => ({ ...current, month: value }));
          }} options={options.months.map(compactMonth)} value={filters.month ? compactMonth(filters.month) : ""} />
          <SelectFilter label="Payout Month" onChange={(label) => {
            const value = options.payouts.find((item) => compactMonth(item) === label) ?? "";
            setFilters((current) => ({ ...current, payout: value }));
          }} options={options.payouts.map(compactMonth)} value={filters.payout ? compactMonth(filters.payout) : ""} />
          <SelectFilter label="Specialist" onChange={(specialist) => setFilters((current) => ({ ...current, specialist }))} options={options.specialists} value={filters.specialist} />
          <SelectFilter label="Status" onChange={(status) => setFilters((current) => ({ ...current, status }))} options={options.statuses} value={filters.status} />
          <SelectFilter label="Request Type" onChange={(requestType) => setFilters((current) => ({ ...current, requestType }))} options={options.requestTypes} value={filters.requestType} />
          <SelectFilter label="Transportation" onChange={(transportationType) => setFilters((current) => ({ ...current, transportationType }))} options={options.transportationTypes} value={filters.transportationType} />
          <SelectFilter
            label="Uploaded Report"
            onChange={(reportId) => setFilters((current) => ({ ...current, reportId }))}
            options={initialReports.map((report) => report.id)}
            value={filters.reportId}
          />
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard icon={ReceiptText} label="Total Expenses" sub={`${formatNumber(summary.trips)} trips`} value={formatEGP(summary.total)} />
        <StatCard icon={Car} label="Travel Cost" sub={`${formatNumber(summary.km)} KM`} tone="blue" value={formatEGP(summary.travel)} />
        <StatCard icon={Users} label="Specialists" sub="Current filter scope" tone="green" value={formatNumber(summary.specialists)} />
        <StatCard icon={CalendarDays} label="Meeting Amount" sub="Meetings and other claims" value={formatEGP(summary.meeting)} />
        <StatCard icon={TrendingUp} label="Avg / Trip" sub="Filtered total divided by trips" tone="red" value={formatEGP(summary.trips ? summary.total / summary.trips : 0)} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
        <MonthlyComparison rows={monthlyRows} />
        <BarRows rows={payoutRows} title="Payout Month Comparison" />
      </div>

      <DestinationChart rows={destinationRows} />

      <div className="grid gap-5 xl:grid-cols-3">
        <BarRows rows={requestRows} title="Request Type Mix" />
        <BarRows rows={transportRows} title="Transportation Mix" />
        <BarRows rows={statusRows} title="Status Mix" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.4fr)]">
        <BarRows rows={specialistRows} title="Top Specialists by Expenses" />
        <SpecialistComparison rows={specialistRows} />
      </div>

      <Card className="rounded-xl border-slate-200 bg-white p-5 shadow-[0_12px_34px_rgba(15,23,42,0.06)]">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="flex items-center gap-3">
            <MapPinned className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs text-slate-500">Travel + Allowance</p>
              <p className="font-bold text-slate-950">{formatEGP(summary.travel + filteredExpenses.reduce((sum, expense) => sum + expense.allowance, 0))}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ReceiptText className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs text-slate-500">Cost / Trip</p>
              <p className="font-bold text-slate-950">{formatEGP(summary.trips ? summary.total / summary.trips : 0)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Car className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs text-slate-500">Cost / KM</p>
              <p className="font-bold text-slate-950">{formatEGP(summary.km ? summary.total / summary.km : 0)}</p>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
