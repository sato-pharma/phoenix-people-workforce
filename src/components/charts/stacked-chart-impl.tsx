"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { cn } from "@/lib/utils";

type StackedChartProps = {
  data: { name: string; value: number; color: string; percent?: number }[];
  centerLabel?: string;
  centerSub?: string;
  onElementClick?: (name: string) => void;
  onHover?: (name: string | null) => void;
  hoveredValue?: string | null;
  type?: "donut" | "pie";
  innerRadius?: number;
  outerRadius?: number;
  showLegend?: boolean;
  tooltipPrefix?: string;
  tooltipSuffix?: string;
};

type StackedTooltipPayload = {
  name?: string;
  value?: number;
};

type StackedTooltipContentProps = {
  active?: boolean;
  payload?: ReadonlyArray<{
    payload?: StackedTooltipPayload;
  }>;
};

const compactEGP = (val: number) => {
  const safe = Number.isFinite(val) ? val : 0;
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(2)}M`;
  if (Math.abs(safe) >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(safe);
};

export function StackedChart({
  data,
  centerLabel,
  centerSub,
  onElementClick,
  onHover,
  hoveredValue,
  type = "donut",
  innerRadius = 55,
  outerRadius = 75,
  showLegend = true,
  tooltipPrefix = "",
  tooltipSuffix = ""
}: StackedChartProps) {
  return (
    <div className={cn(
      "flex items-center gap-4",
      type === "donut" ? "flex-col sm:flex-row" : "flex-row"
    )}>
      <div className={cn(
        "relative shrink-0 transition-all duration-300",
        type === "donut" ? "h-40 w-40 sm:h-44 sm:w-44" : "h-28 w-28 sm:h-32 sm:w-32"
      )}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              innerRadius={innerRadius}
              outerRadius={outerRadius}
              paddingAngle={type === "donut" ? 5 : 0}
              dataKey="value"
              stroke="none"
              onClick={(_, index) => onElementClick?.(data[index]?.name ?? "")}
              onMouseEnter={(_, index) => onHover?.(data[index]?.name ?? null)}
              onMouseLeave={() => onHover?.(null)}
              cursor="pointer"
            >
              {data.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={entry.color}
                  opacity={hoveredValue && hoveredValue !== entry.name ? 0.3 : 1}
                  className="transition-opacity duration-300"
                />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }: StackedTooltipContentProps) => {
                const entry = payload?.[0]?.payload;
                if (active && entry) {
                  return (
                    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
                      <p className="mb-1 text-phx-2xs font-black uppercase tracking-wider text-slate-400">{entry.name ?? "-"}</p>
                      <p className="text-phx-xs font-black text-slate-900">
                        {tooltipPrefix}{Number(entry.value ?? 0).toLocaleString()}{tooltipSuffix}
                      </p>
                    </div>
                  );
                }
                return null;
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        {centerLabel && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
            <p className="text-phx-2xs font-black uppercase tracking-widest text-slate-400">EGP</p>
            <p className="text-lg font-black text-slate-900 leading-none">{centerLabel}</p>
            <p className="text-phx-3xs font-bold text-slate-400 uppercase mt-1">{centerSub}</p>
          </div>
        )}
      </div>
      {showLegend && (
        <div className="flex-1 space-y-3">
          {data.map((item, i) => (
            <div
              key={i}
              className={cn(
                "flex items-center justify-between group cursor-pointer transition-all duration-300",
                hoveredValue && hoveredValue !== item.name ? "opacity-30 scale-95" : "opacity-100 scale-100"
              )}
              onMouseEnter={() => onHover?.(item.name)}
              onMouseLeave={() => onHover?.(null)}
              onClick={() => onElementClick?.(item.name)}
            >
              <div className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                <span className="text-phx-xs font-bold text-slate-600 group-hover:text-slate-900">{item.name}</span>
              </div>
              <span className="text-phx-2xs font-black text-slate-400">
                {compactEGP(item.value).replace("EGP ", "")} {item.percent !== undefined && `(${item.percent}%)`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
