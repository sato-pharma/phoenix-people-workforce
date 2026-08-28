"use client";

import { PieChart } from "lucide-react";
import { ChartCard } from "@/components/cards/chart-card";
import { SectionHeader } from "@/components/ui/section-header";
import { PremiumTooltip } from "@/components/ui/premium-tooltip";
import { ChartProps } from "./chart-types";

type FinancialMixProps = ChartProps & {
  data: {
    sales: { salesValue: number };
    payroll: { net: number; additions: number };
    expenses: { totalAmount: number };
  };
};

function compactEGP(value: number) {
  const safe = Number.isFinite(value) ? value : 0;
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(1)}M`;
  if (Math.abs(safe) >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat("en-US", { currency: "EGP", maximumFractionDigits: 0, style: "currency" }).format(safe);
}

export function FinancialMix({ data, loading = false }: FinancialMixProps) {
  const rows = [
    { color: "#f97316", label: "Sales", value: data.sales.salesValue },
    { color: "#0f172a", label: "Payroll", value: data.payroll.net },
    { color: "#10b981", label: "Expenses", value: data.expenses.totalAmount },
    { color: "#7c3aed", label: "Additions", value: data.payroll.additions },
  ];
  const total = Math.max(rows.reduce((sum, row) => sum + row.value, 0), 1);
  let cursor = 0;
  const gradient = rows
    .map((row) => {
      const start = cursor;
      cursor += (row.value / total) * 100;
      return `${row.color} ${start}% ${cursor}%`;
    })
    .join(", ");

  if (loading) {
    return (
      <ChartCard>
        <div className="h-64 animate-pulse bg-phx-paper rounded-lg" />
      </ChartCard>
    );
  }

  return (
    <ChartCard>
      <SectionHeader icon={PieChart} subtitle="Combined money movement across sales, payroll, expenses, and additions." title="Financial Control Mix" />
      <div className="mt-6 grid gap-6 sm:grid-cols-[170px_minmax(0,1fr)]">
        <div className="relative mx-auto h-28 w-28 rounded-full sm:h-36 sm:w-36 md:h-40 md:w-40" style={{ background: `conic-gradient(${gradient})` }}>
          <div className="absolute inset-4 flex flex-col items-center justify-center rounded-full bg-white shadow-inner sm:inset-6">
            <p className="text-lg font-black text-phx-ink sm:text-xl">{compactEGP(total).replace("EGP ", "")}</p>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-phx-ink-soft">EGP</p>
          </div>
        </div>
        <div className="space-y-3 self-center">
          {rows.map((row) => {
            const percent = ((row.value / total) * 100).toFixed(1);
            const context = row.label === "Sales" ? "Revenue from commercial operations" : 
                          row.label === "Payroll" ? "Employee salary payments" :
                          row.label === "Expenses" ? "Operational and travel costs" : "Payroll adjustments";
            
            return (
              <PremiumTooltip
                content={
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-phx-ink">{row.label}</p>
                    <p className="text-[11px] text-phx-ink-soft">{compactEGP(row.value)}</p>
                    <p className="text-[11px] font-bold text-phx-accent">{percent}% of total</p>
                    <p className="text-[10px] text-phx-ink-soft">{context}</p>
                  </div>
                }
                key={row.label}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-sm font-bold text-phx-ink">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />
                    {row.label}
                  </span>
                  <span className="text-xs font-black text-phx-ink">{compactEGP(row.value)}</span>
                </div>
              </PremiumTooltip>
            );
          })}
        </div>
      </div>
    </ChartCard>
  );
}
