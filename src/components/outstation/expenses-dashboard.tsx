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
import type { ComponentType, ReactNode } from "react";
import { useMemo, useState } from "react";

import { AdminCallout, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCurrencyValue, formatNumberValue } from "@/lib/i18n/format";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  groupPayrollExpenses,
  summarizePayrollExpenses,
  type PayrollExpenseGroupRow,
  type PayrollExpenseSummary,
} from "@/lib/outstation/expense-metrics";
import type {
  PayrollExpenseApproval,
  PayrollExpenseReport,
} from "@/lib/payroll/types";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";


const panelClassName =
  "rounded-[28px] border border-phx-line bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";
const adminTableHeaderClassName = "px-3 py-2 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";

function ExpensesDashboardShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-h-[calc(100vh-8rem)] overflow-hidden rounded-[34px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_32%),linear-gradient(135deg,#FFF9F3_0%,#FFFFFF_44%,#F7FAFC_100%)] p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-phx-accent/12 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-8 left-1/3 h-64 w-64 rounded-full bg-phx-ink/6 blur-3xl"
      />
      <div className="relative z-10 space-y-6">{children}</div>
    </div>
  );
}

type ExpenseFilters = {
  manager: string;
  month: string;
  payout: string;
  reportId: string;
  requestType: string;
  specialist: string;
  status: string;
  transportationType: string;
};

type Props = {
  initialError: string | null;
  initialEmployees: EmployeeDirectoryRow[];
  initialExpenses: PayrollExpenseApproval[];
  initialMetrics?: PayrollExpenseSummary | null;
  initialReports: PayrollExpenseReport[];
  portalMode?: boolean;
};

type GroupRow = PayrollExpenseGroupRow;

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
  icon: ComponentType<{ className?: string }>;
  label: string;
  sub: string;
  tone?: "orange" | "green" | "blue" | "red";
  value: string;
}) {
  const tones = {
    blue: "bg-[#EFF6FF] text-[#1D4ED8] ring-[#BFDBFE]",
    green: "bg-[#ECFDF5] text-[#047857] ring-[#A7F3D0]",
    orange: "bg-phx-accent-soft text-phx-accent-press ring-[#FED7AA]",
    red: "bg-[#FEF2F2] text-[#B91C1C] ring-[#FECACA]",
  };

  return (
    <Card className={cn(panelClassName, "group p-5 transition-transform duration-200 hover:-translate-y-0.5")}>
      <div className="flex items-center gap-4">
        <span className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ring-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]", tones[tone])}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">{label}</p>
          <p className="mt-1 truncate text-2xl font-black text-phx-ink">{value}</p>
          <p className="mt-1 text-xs font-medium text-phx-ink-soft">{sub}</p>
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
      <span className="mb-1 block text-phx-xs font-bold uppercase tracking-[0.14em] text-phx-ink-soft">{label}</span>
      <SearchableSelect
        className="w-full px-3"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </SearchableSelect>
    </label>
  );
}

function BarRows({ rows, title }: { rows: GroupRow[]; title: string }) {
  const max = Math.max(...rows.map((row) => row.total), 1);

  return (
    <Card className={`${panelClassName} p-5`}>
      <h2 className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink">{title}</h2>
      <div className="mt-4 space-y-3">
        {rows.slice(0, 8).map((row, index) => (
          <div className="grid grid-cols-[24px_minmax(0,1fr)_86px] items-center gap-3" key={row.key}>
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-phx-paper text-xs font-black text-phx-ink-soft">
              {index + 1}
            </span>
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-sm font-bold text-phx-ink">{row.key}</p>
                <p className="shrink-0 text-phx-xs font-semibold text-phx-ink-soft">{formatNumber(row.count)} rows</p>
              </div>
              <div className="mt-1.5 h-2 bg-phx-paper-2">
                <div className="h-full bg-phx-accent" style={{ width: `${Math.min((row.total / max) * 100, 100)}%` }} />
              </div>
            </div>
            <p className="text-right text-xs font-black text-phx-ink">{formatEGP(row.total).replace("EGP", "")}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function MonthlyComparison({ rows }: { rows: GroupRow[] }) {
  const max = Math.max(...rows.map((row) => row.total), 1);

  return (
    <Card className={`${panelClassName} p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink">Monthly Comparison</h2>
          <p className="mt-1 text-xs text-phx-ink-soft">Trip month comparison by travel, meetings, allowance, other, total, and KM.</p>
        </div>
      </div>
      <div className="mt-4 overflow-hidden rounded-2xl border border-phx-line bg-white shadow-[0_12px_30px_rgba(15,23,42,0.05)]">
        <PortalResponsiveDataList
          breakpoint="lg"
          empty={<p className="px-3 py-8 text-center text-sm font-semibold text-slate-400">No months in range.</p>}
          getKey={(row) => row.key}
          items={rows}
          renderCard={(row) => (
            <PortalRecordCard
              accent="orange"
              meta={`${formatNumber(row.count)} trips · ${formatNumber(row.km)} km`}
              status={<span className="text-sm font-black tabular-nums text-phx-accent-hover">{formatEGP(row.total)}</span>}
              title={compactMonth(row.key)}
            >
              <PortalRecordFields
                fields={[
                  { label: "Travel", value: formatEGP(row.travel) },
                  { label: "Meeting", value: formatEGP(row.meeting) },
                  { label: "Allowance", value: formatEGP(row.allowance) },
                  { label: "Other", value: formatEGP(row.other) },
                ]}
              />
              <div className="mt-3 h-2 w-full bg-phx-paper-2">
                <div className="h-full bg-phx-accent" style={{ width: `${Math.min((row.total / max) * 100, 100)}%` }} />
              </div>
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              breakpoint="lg"
              cols={
                <colgroup>
                  <col className="w-[14%]" />
                  <col className="w-[8%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[10%]" />
                  <col className="w-[12%]" />
                  <col className="w-[8%]" />
                  <col className="w-[12%]" />
                </colgroup>
              }
            >
            <thead className="bg-phx-paper text-phx-xs uppercase tracking-[0.12em] text-phx-ink-soft">
              <tr>
                <th className={adminTableHeaderClassName}>Month</th>
                <th className={adminTableHeaderClassName}>Trips</th>
                <th className={adminTableHeaderClassName}>Travel</th>
                <th className={adminTableHeaderClassName}>Meeting</th>
                <th className={adminTableHeaderClassName}>Allowance</th>
                <th className={adminTableHeaderClassName}>Other</th>
                <th className={adminTableHeaderClassName}>Total</th>
                <th className={adminTableHeaderClassName}>KM</th>
                <th className={adminTableHeaderClassName}>Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-phx-line bg-white">
              {rows.map((row) => (
                <tr className="transition-colors hover:bg-phx-accent-soft/70" key={row.key}>
                  <td className="px-3 py-2 font-bold text-phx-ink">{compactMonth(row.key)}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatNumber(row.count)}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatEGP(row.travel)}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatEGP(row.meeting)}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatEGP(row.allowance)}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatEGP(row.other)}</td>
                  <td className="px-3 py-2 font-black text-phx-accent-hover">{formatEGP(row.total)}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatNumber(row.km)}</td>
                  <td className="px-3 py-2">
                    <div className="h-2 w-full bg-phx-paper-2">
                      <div className="h-full bg-phx-accent" style={{ width: `${Math.min((row.total / max) * 100, 100)}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            </PortalDesktopTable>
          )}
        />
      </div>
    </Card>
  );
}

function SpecialistComparison({ rows }: { rows: GroupRow[] }) {
  return (
    <Card className={`${panelClassName} p-5`}>
      <h2 className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink">Specialist Detailed Comparison</h2>
      <p className="mt-1 text-xs text-phx-ink-soft">Compare specialists by trips, total, KM, cost per trip, and cost per KM.</p>
      <div className="mt-4 overflow-hidden rounded-2xl border border-phx-line bg-white shadow-[0_12px_30px_rgba(15,23,42,0.05)]">
        <PortalResponsiveDataList
          breakpoint="lg"
          empty={<p className="px-3 py-8 text-center text-sm font-semibold text-slate-400">No specialists in range.</p>}
          getKey={(row) => row.key}
          items={rows.slice(0, 50)}
          renderCard={(row) => (
            <PortalRecordCard
              accent="orange"
              meta={`${formatNumber(row.count)} trips · ${formatNumber(row.km)} km`}
              status={<span className="text-sm font-black tabular-nums text-phx-accent-hover">{formatEGP(row.total)}</span>}
              title={row.key}
            >
              <PortalRecordFields
                fields={[
                  { label: "Travel", value: formatEGP(row.travel) },
                  { label: "Meeting", value: formatEGP(row.meeting) },
                  { label: "Allowance", value: formatEGP(row.allowance) },
                  { label: "Other", value: formatEGP(row.other) },
                  { label: "Cost / Trip", value: formatEGP(row.count ? row.total / row.count : 0) },
                  { label: "Cost / KM", value: formatEGP(row.km ? row.total / row.km : 0) },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              breakpoint="lg"
              cols={
                <colgroup>
                  <col className="w-[18%]" />
                  <col className="w-[7%]" />
                  <col className="w-[11%]" />
                  <col className="w-[10%]" />
                  <col className="w-[10%]" />
                  <col className="w-[11%]" />
                  <col className="w-[9%]" />
                  <col className="w-[7%]" />
                  <col className="w-[8%]" />
                  <col className="w-[9%]" />
                </colgroup>
              }
            >
            <thead className="bg-phx-paper text-phx-xs uppercase tracking-[0.12em] text-phx-ink-soft">
              <tr>
                <th className={adminTableHeaderClassName}>Specialist</th>
                <th className={adminTableHeaderClassName}>Trips</th>
                <th className={adminTableHeaderClassName}>Total</th>
                <th className={adminTableHeaderClassName}>Travel</th>
                <th className={adminTableHeaderClassName}>Meeting</th>
                <th className={adminTableHeaderClassName}>Allowance</th>
                <th className={adminTableHeaderClassName}>Other</th>
                <th className={adminTableHeaderClassName}>KM</th>
                <th className={adminTableHeaderClassName}>Cost / Trip</th>
                <th className={adminTableHeaderClassName}>Cost / KM</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-phx-line bg-white">
              {rows.slice(0, 50).map((row) => (
                <tr className="transition-colors hover:bg-phx-accent-soft/70" key={row.key}>
                  <td className="break-words px-3 py-2 font-bold text-phx-ink">{row.key}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatNumber(row.count)}</td>
                  <td className="px-3 py-2 font-black text-phx-accent-hover">{formatEGP(row.total)}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatEGP(row.travel)}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatEGP(row.meeting)}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatEGP(row.allowance)}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatEGP(row.other)}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatNumber(row.km)}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatEGP(row.count ? row.total / row.count : 0)}</td>
                  <td className="px-3 py-2 text-phx-ink-soft">{formatEGP(row.km ? row.total / row.km : 0)}</td>
                </tr>
              ))}
            </tbody>
            </PortalDesktopTable>
          )}
        />
      </div>
    </Card>
  );
}

function DestinationChart({ rows }: { rows: GroupRow[] }) {
  const max = Math.max(...rows.map((row) => row.total), 1);
  const topRows = rows.slice(0, 10);

  return (
    <Card className={`${panelClassName} p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink">Top Destinations</h2>
          <p className="mt-1 text-xs text-phx-ink-soft">Destination names are normalized before comparison. Bars show total cost; side metric shows cost per visit.</p>
        </div>
        <span className="rounded-full bg-phx-accent-soft px-3 py-1 text-xs font-bold text-phx-accent-press">
          {formatNumber(rows.length)} destinations
        </span>
      </div>
      <div className="mt-5 space-y-4">
        {topRows.length === 0 ? (
          <p className="rounded-2xl border border-phx-line bg-phx-paper p-4 text-sm text-phx-ink-soft">No destination data for the current filters.</p>
        ) : (
          topRows.map((row, index) => {
            const costPerVisit = row.count ? row.total / row.count : 0;
            return (
              <div className="grid gap-2" key={row.key}>
                <div className="grid grid-cols-[28px_minmax(0,1fr)_120px] items-center gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-phx-accent-soft text-xs font-black text-phx-accent-hover">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-phx-ink">{row.key}</p>
                    <p className="text-phx-xs font-semibold text-phx-ink-soft">
                      {formatNumber(row.count)} visits - {formatNumber(row.km)} KM
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-black text-phx-accent-hover">{formatEGP(row.total)}</p>
                    <p className="text-phx-xs font-semibold text-phx-ink-soft">{formatEGP(costPerVisit)} / visit</p>
                  </div>
                </div>
                <div className="ml-10 h-2.5 bg-phx-paper-2">
                  <div className="h-full bg-phx-accent" style={{ width: `${Math.min((row.total / max) * 100, 100)}%` }} />
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
  initialMetrics,
  initialReports,
  portalMode = false,
}: Props) {
  const [filters, setFilters] = useState<ExpenseFilters>({
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
    const metrics = summarizePayrollExpenses(filteredExpenses);
    return {
      approvedAmount: metrics.approvedAmount,
      approvedRows: metrics.approvedRows,
      allowance: metrics.totalAllowance,
      km: metrics.totalDistance,
      meeting: metrics.totalMeetingAmount,
      other: metrics.totalOther,
      specialists: metrics.specialistCount,
      total: metrics.totalAmount,
      travel: metrics.totalTravelCost,
      trips: metrics.totalRows,
    };
  }, [filteredExpenses]);

  const monthlyRows = useMemo(
    () => groupPayrollExpenses(filteredExpenses, (expense) => monthKey(expense.date)).sort((left, right) => left.key.localeCompare(right.key)),
    [filteredExpenses],
  );
  const payoutRows = useMemo(() => groupPayrollExpenses(filteredExpenses, payoutKey), [filteredExpenses]);
  const specialistRows = useMemo(() => groupPayrollExpenses(filteredExpenses, (expense) => expense.specialist), [filteredExpenses]);
  const destinationRows = useMemo(() => groupPayrollExpenses(filteredExpenses, (expense) => normalizeDestination(expense.to || expense.location)), [filteredExpenses]);
  const requestRows = useMemo(() => groupPayrollExpenses(filteredExpenses, (expense) => expense.requestType), [filteredExpenses]);
  const transportRows = useMemo(() => groupPayrollExpenses(filteredExpenses, (expense) => expense.transportationType || "No Transportation"), [filteredExpenses]);
  const statusRows = useMemo(() => groupPayrollExpenses(filteredExpenses, (expense) => expense.status), [filteredExpenses]);
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const compactFilterValue = (name: keyof ExpenseFilters) => {
    switch (name) {
      case "month":
      case "payout":
        return compactMonth(filters[name]);
      default:
        return filters[name];
    }
  };

  const filterLabelByKey: Record<keyof ExpenseFilters, string> = {
    manager: "Manager",
    month: "Trip Month",
    payout: "Payout Month",
    reportId: "Historical Upload",
    requestType: "Request Type",
    specialist: "Specialist",
    status: "Status",
    transportationType: "Transportation",
  };

  const activeFilters = (Object.entries(filters) as Array<[keyof ExpenseFilters, string]>)
    .map(([key, value]) => {
      if (!value) return null;
      return { key, label: `${filterLabelByKey[key]}: ${compactFilterValue(key) || value}` };
    })
    .filter(Boolean) as Array<{ key: keyof ExpenseFilters; label: string }>;

  function clearFilter(name: keyof ExpenseFilters) {
    setFilters((current) => ({ ...current, [name]: "" }));
  }

  function clearFilters() {
    setFilters({
      manager: "",
      month: "",
      payout: "",
      reportId: "",
      requestType: "",
      specialist: "",
      status: "",
      transportationType: "",
    });
  }

  if (initialError) {
    return (
      <ExpensesDashboardShell>
        <AdminPageHero
          description="The expenses dashboard failed to load and cannot render analytics."
          eyebrow="Expenses dashboard"
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          title="Unable to load expense analytics"
        />
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-[#B91C1C]" />
          <p className="font-semibold text-[#B91C1C]">{initialError}</p>
        </AdminCallout>
      </ExpensesDashboardShell>
    );
  }

  return (
    <ExpensesDashboardShell>
    <div className="space-y-5">
      <AdminPageHero
        actions={
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            {!portalMode && (
              <>
                <Link href="/admin/outstation/expense-command?tab=queue">
                  <Button className="gap-2 rounded-xl">
                    <MapPinned className="h-4 w-4" />
                    Review Requests
                  </Button>
                </Link>
                <Link href="/admin/outstation/expense-command?tab=queue&action=create-manager-expense">
                  <Button className="gap-2 rounded-xl" variant="secondary">
                    <ReceiptText className="h-4 w-4" />
                    Add Manual
                  </Button>
                </Link>
                <Link href="/admin/outstation/expenses">
                  <Button className="gap-2 rounded-xl" variant="secondary">
                    <FileSpreadsheet className="h-4 w-4" />
                    Historical Upload
                  </Button>
                </Link>
              </>
            )}
            <Button
              className="gap-2 rounded-xl"
              onClick={clearFilters}
              variant="secondary"
            >
              <BarChart3 className="h-4 w-4" />
              Reset Filters {activeFilterCount ? `(${activeFilterCount})` : ""}
            </Button>
          </div>
        }
        badges={(
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-[#DDE6F1] bg-phx-paper px-3 py-1.5 font-semibold text-phx-ink-soft">Historical uploads: {formatNumber(initialReports.length)}</span>
            <span className="rounded-full border border-[#DDE6F1] bg-phx-paper px-3 py-1.5 font-semibold text-phx-ink-soft">Saved rows: {formatNumber(initialMetrics?.totalRows ?? initialExpenses.length)}</span>
            <span className="rounded-full border border-[#DDE6F1] bg-phx-paper px-3 py-1.5 font-semibold text-phx-ink-soft">Filtered: {formatNumber(summary.trips)} trips</span>
            <span className="rounded-full border border-[#DDE6F1] bg-phx-paper px-3 py-1.5 font-semibold text-phx-ink-soft">{formatEGP(summary.total)} total</span>
          </div>
        )}
        description={portalMode
          ? "Track your outstation expense distribution across trip month, payout month, specialist, status, and transportation with refined dashboard views."
          : "Use this dashboard to review historical uploads, employee outstation requests, manual entries, status, request type, and location in one compact surface."
        }
        eyebrow={portalMode ? "Employee Outstation Expenses" : "Outstation Expense Intelligence"}
        icon={<BarChart3 className="h-3.5 w-3.5" />}
        title={portalMode ? "My Outstation Expenses Dashboard" : "Outstation Expenses Dashboard"}
      />

      <AdminTableShell
        action={activeFilterCount > 0 ? (
          <Button onClick={clearFilters} variant="secondary">
            Reset Filters ({activeFilterCount})
          </Button>
        ) : null}
        description="Use filters to compare exact months, payout periods, specialists, report files, statuses, and expense types."
        title="Comparison Filters"
      >
        <div className="space-y-4 p-4 sm:p-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SelectFilter label="Manager" onChange={(manager) => setFilters((current) => ({ ...current, manager }))} options={options.managers} value={filters.manager} />
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
              label="Historical Upload"
              onChange={(reportId) => setFilters((current) => ({ ...current, reportId }))}
              options={initialReports.map((report) => report.id)}
              value={filters.reportId}
            />
          </div>
          {activeFilters.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-phx-line pt-4">
              {activeFilters.map((filter) => (
                <button
                  className="inline-flex items-center rounded-full border border-phx-line bg-phx-paper px-3 py-1.5 text-xs font-semibold text-phx-ink-soft transition hover:border-phx-accent hover:text-phx-accent-hover"
                  key={filter.key}
                  onClick={() => clearFilter(filter.key)}
                  type="button"
                >
                  {filter.label} [x]
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </AdminTableShell>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <StatCard icon={ReceiptText} label="Total Expenses" sub={`${formatNumber(summary.trips)} trips`} value={formatEGP(summary.total)} />
        <StatCard icon={Car} label="Travel Cost" sub={`${formatNumber(summary.km)} KM`} tone="blue" value={formatEGP(summary.travel)} />
        <StatCard icon={Users} label="Specialists" sub="Current filter scope" tone="green" value={formatNumber(summary.specialists)} />
        <StatCard icon={CalendarDays} label="Meeting Amount" sub="Meetings and other claims" value={formatEGP(summary.meeting)} />
        <StatCard icon={ReceiptText} label="Other" sub="Additional claimed amount" tone="blue" value={formatEGP(summary.other)} />
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

      <Card className={`${panelClassName} p-5`}>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="flex items-center gap-3">
            <MapPinned className="h-5 w-5 text-phx-accent" />
            <div>
              <p className="text-xs text-phx-ink-soft">Travel + Allowance</p>
              <p className="font-bold text-phx-ink">{formatEGP(summary.travel + summary.allowance)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ReceiptText className="h-5 w-5 text-phx-accent" />
            <div>
              <p className="text-xs text-phx-ink-soft">Cost / Trip</p>
              <p className="font-bold text-phx-ink">{formatEGP(summary.trips ? summary.total / summary.trips : 0)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Car className="h-5 w-5 text-phx-accent" />
            <div>
              <p className="text-xs text-phx-ink-soft">Cost / KM</p>
              <p className="font-bold text-phx-ink">{formatEGP(summary.km ? summary.total / summary.km : 0)}</p>
            </div>
          </div>
        </div>
      </Card>
    </div>
    </ExpensesDashboardShell>
  );
}

