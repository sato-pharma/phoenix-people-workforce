"use client";

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";

import { periodProseLabel } from "@/lib/sales/periods";
import { countOf, shortMonthName, trendChartLabel } from "@/lib/sales/territory/drilldown-words";
import type { TerritoryMonthPresence } from "@/lib/sales/territory/types";

type TrendPoint = {
  label: string;
  period: string;
  value: number;
  products: TerritoryMonthPresence["products"];
};

function TrendTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TrendPoint }> }) {
  if (!active || !payload || !payload[0]) return null;
  const point = payload[0].payload;
  return (
    <div className="border border-slate-900 bg-slate-900 px-2.5 py-2 text-phx-xs text-white">
      {/* The month in words ("July 2026"), never the raw "2026-07". */}
      <p className="font-bold text-orange-300">{periodProseLabel(point.period)}</p>
      {point.products.length === 0 ? (
        <p className="mt-0.5 text-slate-300">No sales</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {point.products.map((product) => (
            <li className="flex items-start justify-between gap-3" key={product.productCode || product.productName}>
              <span className="text-slate-200">{product.productName}</span>
              <span className="shrink-0 font-semibold tabular-nums">{countOf(product.units, "unit")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shared 6-bar monthly trend, used by both the desktop and mobile pharmacy cards. Each bar's
 *  height is the month's sales VALUE — never a units total, which is meaningless once two
 *  different products are summed (owner golden rule). Hovering a bar shows the per-product
 *  breakdown for that month in units (e.g. Saginko 100 units, Royafloxacin 70 units), where
 *  each line is a single product and its units ARE valid.
 *
 *  The axis reads the month's own short name from its period, at 11px (it was 9px, below the
 *  page's floor), and the chart names its whole window for a screen reader — the year sits on the
 *  month chips above it. */
export function PharmacyTrendSparkline({ months }: { months: TerritoryMonthPresence[] }) {
  const data: TrendPoint[] = months.map((month) => ({
    label: shortMonthName(month.period),
    period: month.period,
    value: month.value,
    products: month.products,
  }));

  return (
    <div aria-label={trendChartLabel(months.map((month) => month.period))} className="h-16 w-full" role="img">
      <ResponsiveContainer height="100%" width="100%">
        <BarChart data={data} margin={{ bottom: 0, left: 0, right: 4, top: 4 }}>
          <XAxis
            axisLine={false}
            dataKey="label"
            fontSize={11}
            interval={0}
            tick={{ fill: "#64748B" }}
            tickLine={false}
          />
          <Tooltip content={<TrendTooltip />} cursor={{ fill: "rgba(249,115,22,0.08)" }} />
          <Bar dataKey="value" fill="#F97316" radius={[0, 0, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
