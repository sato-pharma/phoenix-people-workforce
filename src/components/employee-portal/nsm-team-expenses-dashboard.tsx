"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { NsmTeamExpensesData } from "@/lib/employee-portal/service";

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatKm(value: number) {
  return `${Math.round(Number.isFinite(value) ? value : 0).toLocaleString()} km`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "N/A";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatRoute(from: string | null | undefined, to: string | null | undefined) {
  const start = String(from ?? "").trim();
  const end = String(to ?? "").trim();

  if (start && end) return `${start} -> ${end}`;
  if (start) return start;
  if (end) return end;
  return "Not provided";
}

function compactPersonName(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 2) return value;
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

function chartTooltipStyle() {
  return {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: 12,
    boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
  };
}

function StatCard({
  helper,
  label,
  value,
}: {
  helper?: string;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
      {helper ? <p className="mt-1 text-xs text-slate-500">{helper}</p> : null}
    </div>
  );
}

export function NsmTeamExpensesDashboard({
  data,
}: {
  data: NsmTeamExpensesData;
}) {
  const dsmRankingData = data.dsms.slice(0, 8).map((dsm) => ({
    fullName: dsm.name,
    shortName: compactPersonName(dsm.name),
    totalExpenses: dsm.totalExpenses,
  }));

  return (
    <div className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          helper={`${data.summary.activeDsms} DSMs in scope`}
          label="Total Expenses"
          value={egp(data.summary.totalExpenses)}
        />
        <StatCard
          helper={`${data.summary.totalTrips.toLocaleString()} trips logged`}
          label="Approved Amount"
          value={egp(data.summary.approvedAmount)}
        />
        <StatCard
          helper={`${data.summary.pendingTrips.toLocaleString()} pending trips`}
          label="Pending Amount"
          value={egp(data.summary.pendingAmount)}
        />
        <StatCard
          helper={formatKm(data.summary.totalDistance)}
          label="Avg Cost / Trip"
          value={egp(data.summary.avgCostPerTrip)}
        />
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
          <div className="mb-5">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Monthly Team Expense Trend
            </p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">
              Expenses and trips by period
            </h2>
          </div>

          <div className="h-80">
            <ResponsiveContainer height="100%" width="100%">
              <ComposedChart data={data.monthlyTrend}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 4" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis
                  yAxisId="expenses"
                  tick={{ fontSize: 12 }}
                  tickFormatter={(value) => egp(Number(value))}
                />
                <YAxis
                  yAxisId="trips"
                  orientation="right"
                  tick={{ fontSize: 12 }}
                />
                <Tooltip
                  contentStyle={chartTooltipStyle()}
                  formatter={(value, name) =>
                    name === "trips"
                      ? Number(value).toLocaleString()
                      : egp(Number(value))
                  }
                />
                <Bar
                  dataKey="expenses"
                  fill="#f97316"
                  radius={[8, 8, 0, 0]}
                  yAxisId="expenses"
                />
                <Line
                  dataKey="trips"
                  dot={{ fill: "#0f172a" }}
                  stroke="#0f172a"
                  strokeWidth={2}
                  yAxisId="trips"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
          <div className="mb-5">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              DSM Expense Ranking
            </p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">
              Highest spend across your DSM team
            </h2>
          </div>

          <div className="h-80">
            <ResponsiveContainer height="100%" width="100%">
              <BarChart
                data={dsmRankingData}
                layout="vertical"
                margin={{ bottom: 8, left: 8, right: 12, top: 4 }}
              >
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 4" />
                <XAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(value) => egp(Number(value))}
                  type="number"
                />
                <YAxis
                  dataKey="shortName"
                  tick={{ fontSize: 11 }}
                  type="category"
                  width={96}
                />
                <Tooltip
                  contentStyle={chartTooltipStyle()}
                  formatter={(value) => egp(Number(value))}
                  labelFormatter={(_, payload) =>
                    payload?.[0] && "payload" in payload[0]
                      ? String((payload[0].payload as { fullName?: string }).fullName ?? "")
                      : ""
                  }
                />
                <Bar
                  dataKey="totalExpenses"
                  fill="#f59e0b"
                  radius={[0, 8, 8, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </section>

      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            DSM Summary
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">
            Team expense dashboard by district manager
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 text-left text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 font-medium text-slate-500">DSM</th>
                <th className="px-4 py-3 font-medium text-slate-500">Trips</th>
                <th className="px-4 py-3 font-medium text-slate-500">Approved</th>
                <th className="px-4 py-3 font-medium text-slate-500">Pending</th>
                <th className="px-4 py-3 font-medium text-slate-500">Distance</th>
                <th className="px-4 py-3 font-medium text-slate-500">Avg Cost</th>
                <th className="px-4 py-3 font-medium text-slate-500">Last Trip</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {data.dsms.map((dsm) => (
                <tr key={dsm.hrId} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-semibold text-slate-900">{dsm.name}</p>
                      <p className="text-xs text-slate-500">
                        {dsm.hrId}
                        {dsm.lineName ? ` | ${dsm.lineName}` : ""}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {dsm.totalTrips.toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="space-y-1">
                      <p className="font-medium text-slate-900">
                        {egp(dsm.approvedAmount)}
                      </p>
                      <p className="text-xs text-slate-500">
                        {dsm.approvedTrips.toLocaleString()} trips
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="space-y-1">
                      <p className="font-medium text-slate-900">
                        {egp(dsm.pendingAmount)}
                      </p>
                      <p className="text-xs text-slate-500">
                        {dsm.pendingTrips.toLocaleString()} trips
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {formatKm(dsm.totalDistance)}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {egp(dsm.avgCostPerTrip)}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {formatDate(dsm.lastTripDate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Recent Team Expense Rows
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">
            Latest DSM trips in the selected scope
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 text-left text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 font-medium text-slate-500">DSM</th>
                <th className="px-4 py-3 font-medium text-slate-500">Trip</th>
                <th className="px-4 py-3 font-medium text-slate-500">Date</th>
                <th className="px-4 py-3 font-medium text-slate-500">Request Type</th>
                <th className="px-4 py-3 font-medium text-slate-500">Route</th>
                <th className="px-4 py-3 font-medium text-slate-500">Total</th>
                <th className="px-4 py-3 font-medium text-slate-500">KM</th>
                <th className="px-4 py-3 font-medium text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {data.expenseRows.slice(0, 20).map((expense) => (
                <tr
                  key={`${expense.tripId}-${expense.date}-${expense.dsmName}`}
                  className="hover:bg-slate-50"
                >
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-medium text-slate-900">{expense.dsmName}</p>
                      <p className="text-xs text-slate-500">
                        {expense.hrId ?? "N/A"}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {expense.tripId || "N/A"}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {formatDate(expense.date)}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {expense.requestType || "Other"}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {formatRoute(expense.from, expense.to)}
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-900">
                    {egp(expense.total)}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {formatKm(expense.km)}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={expense.hrApproved ? "success" : "warning"}>
                      {expense.hrApproved ? "Approved" : "Pending"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
