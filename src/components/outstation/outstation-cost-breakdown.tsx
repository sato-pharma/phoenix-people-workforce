"use client";

import { Card } from "@/components/ui/card";
import type { OutstationCalculationResult } from "@/lib/outstation/types";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";

function egp(value: number) {
  return stableCurrencyFormatter("en-US", {
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
    <Card className="rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
      <span className="rounded-md bg-orange-50 px-2 py-1 text-phx-sm font-bold uppercase tracking-wider text-orange-600">
        Cost breakdown
      </span>
      <div className="mt-3 grid grid-cols-1 divide-x divide-y divide-gray-100 overflow-hidden rounded-md border border-gray-100 sm:grid-cols-2 xl:grid-cols-4">
        <Line accent="border-l-orange-400" label="Fuel Amount" value={egp(result.fuelAmount)} />
        <Line accent="border-l-emerald-400" label="Allowance" value={egp(result.allowanceAmount)} />
        <Line accent="border-l-sky-400" label="Ticket Amount" value={egp(result.ticketAmount)} />
        <Line
          accent="border-l-slate-400"
          label="Claimed Total"
          value={egp(result.claimedTotalAmount)}
        />
        <Line
          accent="border-l-emerald-300"
          label="Same Day Trip"
          value={result.sameDayTrip ? "Yes" : "No"}
        />
        <Line
          accent="border-l-sky-300"
          label="Overnight Days"
          value={String(result.overnightDays)}
        />
      </div>
      <div className="mt-3 rounded-md border border-gray-100 bg-slate-50/60 p-3">
        <p className="text-phx-sm font-semibold uppercase tracking-wider text-slate-500">
          Allowance Breakdown
        </p>
        <div className="mt-2 divide-y divide-gray-100">
          {result.allowanceBreakdown.rows.map((row, index) => (
            <div
              className="flex items-center justify-between gap-3 py-1.5 text-phx-md"
              key={`${row.type}-${index}`}
            >
              <span className="font-medium text-slate-600">{row.label}</span>
              <span className="font-bold text-slate-800">{egp(row.amount)}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function Line({
  accent,
  label,
  value,
}: {
  accent: string;
  label: string;
  value: string;
}) {
  return (
    <div className={`border-l-2 ${accent} px-3 py-3`}>
      <p className="text-phx-sm font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className="mt-1 truncate text-phx-md font-semibold text-slate-800" title={value}>
        {value}
      </p>
    </div>
  );
}
