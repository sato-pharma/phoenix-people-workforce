"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { Card } from "@/components/ui/card";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import type { NsmTeamExpensesData } from "@/lib/employee-portal/service";
import {
  EXPENSE_STATE_LABEL,
  expenseApprovalState,
  type ExpenseApprovalState,
} from "@/lib/outstation/approval-state";
import { formatEmployeeDisplayName } from "@/lib/utils";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";

/* ---------- helpers ---------- */

function egp(value: number) {
  return stableCurrencyFormatter("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function compactEgp(value: number) {
  return stableCurrencyFormatter("en-US", {
    compactDisplay: "short",
    currency: "EGP",
    maximumFractionDigits: 1,
    notation: "compact",
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatKm(value: number) {
  return `${Math.round(Number.isFinite(value) ? value : 0).toLocaleString()} km`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return stableEnGbFormatter({
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatRoute(from: string | null | undefined, to: string | null | undefined) {
  const start = String(from ?? "").trim();
  const end = String(to ?? "").trim();
  if (start && end) return `${start} → ${end}`;
  if (start) return start;
  if (end) return end;
  return "Not provided";
}

/** Expense-level color grading (relative spend intensity). */
function expenseColor(value: number, maxValue: number): string {
  if (maxValue <= 0) return "#94a3b8";
  const ratio = value / maxValue;
  if (ratio >= 0.8) return "#ef4444"; // red – highest spenders
  if (ratio >= 0.6) return "#f97316"; // orange
  if (ratio >= 0.4) return "#f59e0b"; // amber
  return "#10b981"; // green – lower spenders
}

/**
 * Trip status colours, one entry per approval state.
 *
 * Approval is 3-state; keying these off `hrApproved` alone painted every rejected trip amber and
 * labelled it Pending, on the same page whose Pending stat card deliberately excludes it.
 */
const stateTone: Record<
  ExpenseApprovalState,
  { accent: string; background: string; text: string }
> = {
  approved: { accent: "#10b981", background: "#dcfce7", text: "#15803d" },
  pending: { accent: "#f59e0b", background: "#fef3c7", text: "#92400e" },
  rejected: { accent: "#f43f5e", background: "#ffe4e6", text: "#be123c" },
};

/** Thin left-border color per stat context. */
const statBorders: Record<string, string> = {
  "Total Expenses": "border-l-orange-400",
  "Approved Amount": "border-l-emerald-400",
  "Pending Amount": "border-l-amber-400",
  "Avg Cost / Trip": "border-l-sky-400",
};

/* ---------- chart tooltips ---------- */

function TrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="max-w-[calc(100vw-4rem)] rounded border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <p className="mb-1 break-words font-semibold text-slate-900">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="text-slate-600">
          {p.name === "trips" ? "Trips" : "Expenses"}:{" "}
          <span className="font-medium" style={{ color: p.color }}>
            {p.name === "trips" ? Number(p.value).toLocaleString() : egp(Number(p.value))}
          </span>
        </p>
      ))}
    </div>
  );
}

function RankingTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { fullName?: string; totalExpenses: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="max-w-[calc(100vw-4rem)] rounded border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <p className="mb-1 break-words font-semibold text-slate-900">{d.fullName ?? ""}</p>
      <p className="text-slate-600">
        Total: <span className="font-bold text-slate-900">{egp(d.totalExpenses)}</span>
      </p>
    </div>
  );
}

/* ---------- dashboard ---------- */

export function NsmTeamExpensesDashboard({
  data,
}: {
  data: NsmTeamExpensesData;
}) {
  const dsmRankingData = data.dsms.slice(0, 8).map((dsm) => ({
    fullName: dsm.name,
    shortName: formatEmployeeDisplayName(dsm.name),
    totalExpenses: dsm.totalExpenses,
  }));

  const maxExpense = Math.max(...data.dsms.map((d) => d.totalExpenses), 1);

  const stats = [
    {
      label: "Total Expenses",
      value: egp(data.summary.totalExpenses),
      helper: `${data.summary.activeDsms} DSMs in scope`,
    },
    {
      label: "Approved Amount",
      value: egp(data.summary.approvedAmount),
      helper: `${data.summary.approvedTrips.toLocaleString()} approved trips`,
    },
    {
      label: "Pending Amount",
      value: egp(data.summary.pendingAmount),
      helper: `${data.summary.pendingTrips.toLocaleString()} pending trips`,
    },
    {
      label: "Avg Cost / Trip",
      value: egp(data.summary.avgCostPerTrip),
      helper: formatKm(data.summary.totalDistance),
    },
  ];

  return (
    <div className="space-y-5 sm:space-y-7">
      {/* ── Stat Cards with Thin Gridlines ── */}
      <Card className="rounded border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.08)] print:shadow-none print:break-inside-avoid">
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y divide-slate-100">
          {stats.map((stat) => (
            <div
              className={`min-w-0 border-l-2 ${statBorders[stat.label] ?? "border-l-slate-300"} bg-white px-3 py-3 sm:px-4 sm:py-4`}
              key={stat.label}
            >
              <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                {stat.label}
              </p>
              <p className="mt-1.5 break-words text-lg font-bold text-slate-900 sm:text-xl">
                {stat.value}
              </p>
              {stat.helper ? (
                <p className="mt-1 text-phx-xs font-medium text-slate-400">{stat.helper}</p>
              ) : null}
            </div>
          ))}
        </div>
      </Card>

      {/* ── Charts (Trend + Ranking) ── */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="min-w-0 overflow-hidden rounded border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6 print:shadow-none print:break-inside-avoid">
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">
              Monthly Trend
            </p>
            <h2 className="mt-1 break-words text-sm font-semibold text-slate-900">
              Expenses and Trips by Period
            </h2>
          </div>
          <WorkspaceErrorBoundary fallbackTitle="Chart failed to render">
            <div role="img" aria-label="Monthly expense trend chart showing expenses as bars and trips as a line overlay">
              <SafeResponsiveContainer className="h-72 sm:h-80" minHeight={288}>
                <ComposedChart data={data.monthlyTrend} margin={{ left: 0, right: 4, top: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 10, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="expenses"
                    tick={{ fontSize: 10, fill: "#94a3b8" }}
                    tickFormatter={(value) => compactEgp(Number(value))}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                  />
                  <YAxis
                    yAxisId="trips"
                    orientation="right"
                    tick={{ fontSize: 10, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    width={28}
                  />
                  <Tooltip content={<TrendTooltip />} />
                  <Bar
                    dataKey="expenses"
                    fill="#f97316"
                    radius={[0, 0, 0, 0]}
                    yAxisId="expenses"
                  />
                  <Line
                    dataKey="trips"
                    dot={{ fill: "#0f172a", r: 3 }}
                    stroke="#0f172a"
                    strokeWidth={2}
                    yAxisId="trips"
                  />
                </ComposedChart>
              </SafeResponsiveContainer>
            </div>
          </WorkspaceErrorBoundary>
        </Card>

        <Card className="min-w-0 overflow-hidden rounded border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6 print:shadow-none print:break-inside-avoid">
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">
              DSM Expense Ranking
            </p>
            <h2 className="mt-1 break-words text-sm font-semibold text-slate-900">
              Highest Spend Across Your DSM Team
            </h2>
          </div>
          <WorkspaceErrorBoundary fallbackTitle="Chart failed to render">
            <div role="img" aria-label="DSM expense ranking horizontal bar chart showing total expenses per district manager">
              <SafeResponsiveContainer className="h-72 sm:h-80" minHeight={288}>
                <BarChart
                  data={dsmRankingData}
                  layout="vertical"
                  margin={{ bottom: 4, left: 0, right: 8, top: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis
                    tick={{ fontSize: 10, fill: "#94a3b8" }}
                    tickFormatter={(value) => compactEgp(Number(value))}
                    type="number"
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    dataKey="shortName"
                    tick={{ fontSize: 10, fill: "#475569" }}
                    type="category"
                    width={86}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip content={<RankingTooltip />} />
                  <Bar dataKey="totalExpenses" radius={[0, 0, 0, 0]}>
                    {dsmRankingData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={expenseColor(entry.totalExpenses, maxExpense)} />
                    ))}
                  </Bar>
                </BarChart>
              </SafeResponsiveContainer>
            </div>
          </WorkspaceErrorBoundary>
        </Card>
      </div>

      {/* ── DSM Summary Table ── */}
      <Card className="min-w-0 overflow-hidden rounded border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6 print:shadow-none print:break-inside-avoid">
        <div className="mb-4 sm:mb-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">
            DSM Summary
          </p>
          <h2 className="mt-1 break-words text-sm font-semibold text-slate-900">
            Team Expense Dashboard by District Manager
          </h2>
        </div>

        {/* Mobile card view */}
        <div className="grid gap-2.5 md:hidden">
          {data.dsms.map((dsm) => {
            const spendRatio = maxExpense > 0 ? dsm.totalExpenses / maxExpense : 0;
            const color = expenseColor(dsm.totalExpenses, maxExpense);
            return (
              <div
                className="relative min-w-0 overflow-hidden rounded border border-slate-100 bg-white shadow-sm"
                key={dsm.hrId}
              >
                <div className="absolute inset-y-0 left-0 w-[3px]" style={{ backgroundColor: color }} />
                <div className="pl-4 pr-3 pt-3 pb-2.5">
                  <div className="flex items-start gap-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-semibold leading-tight text-slate-900">
                        {formatEmployeeDisplayName(dsm.name)}
                      </p>
                      <p className="mt-0.5 break-words text-phx-sm text-slate-400">
                        {dsm.lineName}
                      </p>
                    </div>
                    <p className="shrink-0 text-base font-bold" style={{ color }}>
                      {compactEgp(dsm.totalExpenses)}
                    </p>
                  </div>

                  {/* Spend bar */}
                  <div className="mt-2 h-1.5 rounded bg-slate-100 overflow-hidden">
                    <div
                      className="h-full rounded transition-all duration-500"
                      style={{ width: `${Math.min(100, spendRatio * 100)}%`, backgroundColor: color }}
                    />
                  </div>

                  {/* Metadata pills */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center rounded bg-emerald-50 px-1.5 py-0.5 text-phx-sm font-medium text-emerald-700">
                      Approved: {compactEgp(dsm.approvedAmount)}
                    </span>
                    {dsm.pendingAmount > 0 && (
                      <span className="inline-flex items-center rounded bg-amber-50 px-1.5 py-0.5 text-phx-sm font-medium text-amber-700">
                        Pending: {compactEgp(dsm.pendingAmount)}
                      </span>
                    )}
                    <span className="inline-flex items-center rounded bg-slate-50 px-1.5 py-0.5 text-phx-sm font-medium text-slate-600">
                      {dsm.totalTrips} trips
                    </span>
                    <span className="inline-flex items-center rounded bg-slate-50 px-1.5 py-0.5 text-phx-sm font-medium text-slate-600">
                      Avg: {egp(dsm.avgCostPerTrip)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Desktop table view */}
        <div className="hidden md:block">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-[22%]" />
              <col className="w-[8%]" />
              <col className="w-[16%]" />
              <col className="w-[16%]" />
              <col className="w-[12%]" />
              <col className="w-[13%]" />
              <col className="w-[13%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">DSM</th>
                <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">Trips</th>
                <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">Approved</th>
                <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">Pending</th>
                <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">Distance</th>
                <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">Avg Cost</th>
                <th className="text-right py-2 px-3 text-xs font-medium text-slate-500">Last Trip</th>
              </tr>
            </thead>
            <tbody>
              {data.dsms.map((dsm) => (
                <tr key={dsm.hrId} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                  <td className="min-w-0 py-2.5 px-3 border-r border-slate-100">
                    <p className="break-words font-medium leading-tight text-slate-900">{formatEmployeeDisplayName(dsm.name)}</p>
                    {dsm.lineName ? <p className="break-words text-phx-sm text-slate-400">{dsm.lineName}</p> : null}
                  </td>
                  <td className="py-2.5 px-3 text-right border-r border-slate-100 text-slate-700">
                    {dsm.totalTrips.toLocaleString()}
                  </td>
                  <td className="py-2.5 px-3 text-right border-r border-slate-100">
                    <p className="font-medium text-slate-900">{egp(dsm.approvedAmount)}</p>
                    <p className="text-phx-sm text-slate-400">{dsm.approvedTrips} trips</p>
                  </td>
                  <td className="py-2.5 px-3 text-right border-r border-slate-100">
                    <p className="font-medium text-slate-900">{egp(dsm.pendingAmount)}</p>
                    <p className="text-phx-sm text-slate-400">{dsm.pendingTrips} trips</p>
                  </td>
                  <td className="py-2.5 px-3 text-right border-r border-slate-100 text-slate-700">
                    {formatKm(dsm.totalDistance)}
                  </td>
                  <td className="py-2.5 px-3 text-right border-r border-slate-100 text-slate-700">
                    {egp(dsm.avgCostPerTrip)}
                  </td>
                  <td className="py-2.5 px-3 text-right text-slate-700">
                    {formatDate(dsm.lastTripDate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ── Recent Expense Rows ── */}
      <Card className="min-w-0 overflow-hidden rounded border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6 print:shadow-none print:break-inside-avoid">
        <div className="mb-4 sm:mb-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">
            Recent Trips
          </p>
          <h2 className="mt-1 break-words text-sm font-semibold text-slate-900">
            Latest DSM Trips in Selected Scope
          </h2>
        </div>

        {/* Mobile card view */}
        <div className="grid gap-2.5 md:hidden">
          {data.expenseRows.slice(0, 20).map((expense) => {
            const state = expenseApprovalState(expense);
            const tone = stateTone[state];

            return (
              <div
                className="relative min-w-0 overflow-hidden rounded border border-slate-100 bg-white shadow-sm"
                key={`${expense.tripId}-${expense.date}-${expense.dsmName}`}
              >
                <div
                  className="absolute inset-y-0 left-0 w-[3px]"
                  style={{ backgroundColor: tone.accent }}
                />
                <div className="pl-4 pr-3 pt-3 pb-2.5">
                  <div className="flex items-start gap-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-semibold leading-tight text-slate-900">
                        {expense.dsmName}
                      </p>
                      <p className="mt-0.5 text-phx-sm text-slate-400">
                        {formatDate(expense.date)}{expense.tripId ? ` · Trip #${expense.tripId}` : ""}
                      </p>
                    </div>
                    <p className="shrink-0 text-base font-bold text-slate-900">
                      {egp(expense.total)}
                    </p>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span
                      className="inline-flex items-center rounded px-1.5 py-0.5 text-phx-sm font-medium"
                      style={{ backgroundColor: tone.background, color: tone.text }}
                    >
                      {EXPENSE_STATE_LABEL[state]}
                    </span>
                    <span className="inline-flex items-center rounded bg-slate-50 px-1.5 py-0.5 text-phx-sm font-medium text-slate-600">
                      {expense.requestType || "Other"}
                    </span>
                    <span className="inline-flex items-center rounded bg-slate-50 px-1.5 py-0.5 text-phx-sm font-medium text-slate-600">
                      {formatKm(expense.km)}
                    </span>
                  </div>

                  <p className="mt-1.5 break-words text-phx-sm text-slate-400">
                    {formatRoute(expense.from, expense.to)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Desktop table view */}
        <div className="hidden md:block">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-[16%]" />
              <col className="w-[8%]" />
              <col className="w-[11%]" />
              <col className="w-[11%]" />
              <col className="w-[22%]" />
              <col className="w-[12%]" />
              <col className="w-[8%]" />
              <col className="w-[12%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">DSM</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">Trip</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">Date</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">Type</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">Route</th>
                <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">Total</th>
                <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">KM</th>
                <th className="text-center py-2 px-3 text-xs font-medium text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.expenseRows.slice(0, 20).map((expense) => {
                const state = expenseApprovalState(expense);

                return (
                  <tr
                    key={`${expense.tripId}-${expense.date}-${expense.dsmName}`}
                    className="border-b border-slate-100 hover:bg-slate-50 transition-colors"
                  >
                    <td className="min-w-0 py-2.5 px-3 border-r border-slate-100">
                      <p className="break-words font-medium leading-tight text-slate-900">{expense.dsmName}</p>
                    </td>
                    <td className="break-words py-2.5 px-3 text-slate-700 border-r border-slate-100">
                      {expense.tripId || "—"}
                    </td>
                    <td className="py-2.5 px-3 text-slate-700 border-r border-slate-100">
                      {formatDate(expense.date)}
                    </td>
                    <td className="py-2.5 px-3 text-slate-700 border-r border-slate-100">
                      {expense.requestType || "Other"}
                    </td>
                    <td className="min-w-0 py-2.5 px-3 border-r border-slate-100">
                      <p className="break-words text-slate-700">{formatRoute(expense.from, expense.to)}</p>
                    </td>
                    <td className="py-2.5 px-3 text-right font-medium text-slate-900 border-r border-slate-100">
                      {egp(expense.total)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-700 border-r border-slate-100">
                      {formatKm(expense.km)}
                    </td>
                    <td className="py-2.5 px-3 text-center">
                      <span
                        className="inline-flex break-words px-2 py-0.5 text-phx-xs font-semibold"
                        style={{
                          backgroundColor: stateTone[state].background,
                          color: stateTone[state].text,
                        }}
                      >
                        {EXPENSE_STATE_LABEL[state]}
                      </span>
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
