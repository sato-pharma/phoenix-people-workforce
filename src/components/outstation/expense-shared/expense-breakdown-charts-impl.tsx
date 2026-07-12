"use client";

import { Cell, Pie, PieChart, Tooltip } from "recharts";

import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { compactEgp, egp, EXPENSE_SOURCE_LABELS } from "@/components/outstation/expense-shared/formatters";
import type {
  ExpenseCommandBreakdowns,
  ExpenseCommandKpis,
  ExpenseSource,
} from "@/components/outstation/expense-shared/types";
import type { PayrollExpenseGroupRow } from "@/lib/outstation/expense-metrics";

// Distinct hues so adjacent slices never read as the same colour (orange stays the
// brand lead, then clearly different colours per slice).
const PIE_COLORS = ["#F97316", "#0F172A", "#3B82F6", "#10B981", "#8B5CF6", "#F43F5E", "#FBBF24", "#06B6D4"];

function BreakdownCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-[18px] border border-[#D8E0EA] bg-white shadow-[0_18px_46px_rgba(15,23,42,0.08)]">
      <div className="flex items-center gap-2.5 border-b border-slate-200/80 bg-gradient-to-b from-white to-slate-50/50 px-5 py-4">
        <span className="h-2 w-2 rounded-full bg-gradient-to-r from-orange-500 to-amber-400 shadow-[0_0_8px_rgba(249,115,22,0.5)]" />
        <div>
          <h3 className="text-sm font-black tracking-tight text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500">{description}</p>
        </div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function ShareBarList({
  rows,
  onSelect,
}: {
  rows: PayrollExpenseGroupRow[];
  onSelect?: (key: string) => void;
}) {
  const top = rows.slice(0, 8);
  const max = top.reduce((peak, row) => Math.max(peak, row.total), 0) || 1;

  if (top.length === 0) {
    return <p className="py-6 text-center text-sm font-semibold text-slate-400">No data for these filters.</p>;
  }

  return (
    <ul className="space-y-2.5">
      {top.map((row) => (
        <li key={row.key}>
          <button
            type="button"
            onClick={() => onSelect?.(row.key)}
            className="group flex w-full items-center gap-3 text-left"
          >
            <span className="w-32 shrink-0 truncate text-xs font-semibold text-slate-700 group-hover:text-[#C2410C]">
              {row.key}
            </span>
            <span className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-orange-400 to-orange-600"
                style={{ width: `${Math.max(4, (row.total / max) * 100)}%` }}
              />
            </span>
            <span className="w-20 shrink-0 text-right text-xs font-black tabular-nums text-slate-900">
              {compactEgp(row.total)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Donut({
  data,
  onSelect,
}: {
  data: Array<{ name: string; value: number; selectKey: string }>;
  onSelect?: (key: string) => void;
}) {
  const filtered = data.filter((slice) => slice.value > 0);
  if (filtered.length === 0) {
    return <p className="py-6 text-center text-sm font-semibold text-slate-400">No data for these filters.</p>;
  }
  const total = filtered.reduce((sum, slice) => sum + slice.value, 0);

  return (
    <div className="flex items-center gap-4">
      <div className="h-[150px] w-[150px] shrink-0">
        <SafeResponsiveContainer minHeight={150} style={{ height: 150 }}>
          <PieChart>
            <Pie
              data={filtered}
              dataKey="value"
              nameKey="name"
              innerRadius={42}
              outerRadius={70}
              paddingAngle={2}
              onClick={(entry) => {
                const meta = entry as unknown as {
                  selectKey?: string;
                  payload?: { selectKey?: string };
                };
                const key = meta.selectKey ?? meta.payload?.selectKey;
                if (key) onSelect?.(key);
              }}
            >
              {filtered.map((slice, index) => (
                <Cell
                  key={slice.selectKey}
                  cursor="pointer"
                  fill={PIE_COLORS[index % PIE_COLORS.length]}
                />
              ))}
            </Pie>
            <Tooltip formatter={(value) => egp(Number(value))} />
          </PieChart>
        </SafeResponsiveContainer>
      </div>
      <ul className="min-w-0 flex-1 space-y-1.5">
        {filtered.map((slice, index) => (
          <li key={slice.selectKey}>
            <button
              type="button"
              onClick={() => onSelect?.(slice.selectKey)}
              className="group flex w-full items-center justify-between gap-2 text-left"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }}
                />
                <span className="truncate text-xs font-semibold text-slate-700 group-hover:text-[#C2410C]">
                  {slice.name}
                </span>
              </span>
              <span className="shrink-0 text-xs font-black tabular-nums text-slate-900">
                {total > 0 ? `${Math.round((slice.value / total) * 100)}%` : "—"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ExpenseBreakdownCharts({
  breakdowns,
  bySource,
  onSelectRegion,
  onSelectTransport,
  onSelectSource,
  onSelectExpenseType,
}: {
  breakdowns: ExpenseCommandBreakdowns;
  bySource: ExpenseCommandKpis["bySource"];
  onSelectRegion?: (region: string) => void;
  onSelectTransport?: (transport: string) => void;
  onSelectSource?: (source: ExpenseSource) => void;
  onSelectExpenseType?: (expenseType: string) => void;
}) {
  const sourceData = (Object.keys(bySource) as ExpenseSource[]).map((source) => ({
    name: EXPENSE_SOURCE_LABELS[source],
    value: bySource[source].amount,
    selectKey: source,
  }));

  const expenseTypeData = breakdowns.byExpenseType.map((row) => ({
    name: row.key,
    value: row.total,
    selectKey: row.key,
  }));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <BreakdownCard title="Spend by region" description="Brick-master area. Click to filter.">
        <ShareBarList rows={breakdowns.byRegion} onSelect={onSelectRegion} />
      </BreakdownCard>
      <BreakdownCard title="Spend by source" description="Where the expense entered. Click to filter.">
        <Donut data={sourceData} onSelect={(key) => onSelectSource?.(key as ExpenseSource)} />
      </BreakdownCard>
      <BreakdownCard title="Spend by transportation" description="Travel mode. Click to filter.">
        <ShareBarList rows={breakdowns.byTransportation} onSelect={onSelectTransport} />
      </BreakdownCard>
      <BreakdownCard title="Spend by type" description="Expense category. Click to filter.">
        <Donut data={expenseTypeData} onSelect={onSelectExpenseType} />
      </BreakdownCard>
    </div>
  );
}
