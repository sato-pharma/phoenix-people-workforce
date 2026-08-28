"use client";

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";

import { periodProseLabel } from "@/lib/sales/periods";
import type { TerritoryMonthPresence } from "@/lib/sales/territory/types";

type TrendPoint = {
  label: string;
  period: string;
  units: number;
  products: TerritoryMonthPresence["products"];
};

function TrendTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TrendPoint }> }) {
  if (!active || !payload || !payload[0]) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2 text-phx-xs text-white shadow-lg">
      <p className="font-bold text-orange-300">{point.period}</p>
      {point.products.length === 0 ? (
        <p className="mt-0.5 text-slate-300">No sales</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {point.products.map((product) => (
            <li className="flex items-center justify-between gap-3" key={product.productCode || product.productName}>
              <span className="text-slate-200">{product.productName}</span>
              <span className="font-semibold tabular-nums">{product.units} unit{product.units === 1 ? "" : "s"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shared 6-bar monthly trend, used by both the desktop and mobile pharmacy cards. Hovering
 *  a bar shows the per-product breakdown for that month (e.g. Saginko 100 units, Royafloxacin
 *  70 units), not just the summed total. */
export function PharmacyTrendSparkline({ months }: { months: TerritoryMonthPresence[] }) {
  const data: TrendPoint[] = months.map((month) => ({
    label: periodProseLabel(month.period).slice(0, 3),
    period: month.period,
    units: month.units,
    products: month.products,
  }));

  return (
    <div className="h-16 w-full">
      <ResponsiveContainer height="100%" width="100%">
        <BarChart data={data} margin={{ bottom: 0, left: 0, right: 4, top: 4 }}>
          <XAxis
            axisLine={false}
            dataKey="label"
            fontSize={9}
            interval={0}
            tick={{ fill: "#94A3B8" }}
            tickLine={false}
          />
          <Tooltip content={<TrendTooltip />} cursor={{ fill: "rgba(249,115,22,0.08)" }} />
          <Bar dataKey="units" fill="#F97316" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
