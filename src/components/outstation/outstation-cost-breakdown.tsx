"use client";

import { Card } from "@/components/ui/card";
import type { OutstationCalculationResult } from "@/lib/outstation/types";

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

export function OutstationCostBreakdown({
  result,
}: {
  result: OutstationCalculationResult | null;
}) {
  if (!result) return null;

  return (
    <Card className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
        Cost Breakdown
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Line label="Fuel Amount" value={egp(result.fuelAmount)} />
        <Line label="Allowance" value={egp(result.allowanceAmount)} />
        <Line label="Ticket Amount" value={egp(result.ticketAmount)} />
        <Line label="Expected Total" value={egp(result.expectedTotalAmount)} />
        <Line label="Claimed Total" value={egp(result.claimedTotalAmount)} />
        <Line label="Variance" value={`${egp(result.varianceAmount)} (${result.variancePercent.toFixed(1)}%)`} />
        <Line label="Same Day Trip" value={result.sameDayTrip ? "Yes" : "No"} />
        <Line label="Overnight Days" value={String(result.overnightDays)} />
      </div>
      <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Allowance Breakdown</p>
        <div className="mt-3 space-y-2">
          {result.allowanceBreakdown.rows.map((row, index) => (
            <div className="flex items-center justify-between gap-3 text-sm" key={`${row.type}-${index}`}>
              <span className="font-semibold text-slate-700">{row.label}</span>
              <span className="font-black text-slate-950">{egp(row.amount)}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function Line({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
