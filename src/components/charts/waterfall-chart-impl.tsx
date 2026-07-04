"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

type WaterfallChartProps = {
  data: { name: string; val: number; breakdown?: string }[];
  height?: number;
  color?: string;
  activeValue?: string | null;
  onElementClick?: (name: string) => void;
};

type WaterfallTooltipRow = {
  breakdown?: string;
  name?: string;
  val?: number;
};

type WaterfallTooltipContentProps = {
  active?: boolean;
  payload?: ReadonlyArray<{
    payload?: WaterfallTooltipRow;
  }>;
};

const compactEGP = (val: number) => {
  const safe = Number.isFinite(val) ? val : 0;
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(2)}M`;
  if (Math.abs(safe) >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(safe);
};

export function WaterfallChart({
  data,
  height = 200,
  color = "#F97316",
  activeValue,
  onElementClick
}: WaterfallChartProps) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          onClick={(_, index) => {
            const name = typeof index === "number" ? data[index]?.name : null;
            if (name) onElementClick?.(name);
          }}
        >
          <XAxis dataKey="name" hide />
          <YAxis hide />
          <Tooltip
            content={({ active, payload }: WaterfallTooltipContentProps) => {
              const item = payload?.[0]?.payload;
              if (active && item) {
                return (
                  <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
                    <p className="text-[10px] font-black uppercase text-slate-400">{item.name ?? "-"}</p>
                    <p className="text-lg font-black text-slate-900">{compactEGP(Number(item.val ?? 0))}</p>
                    <p className="mt-1 text-[9px] font-bold text-orange-500 uppercase tracking-tighter">Click to see impact</p>
                    {item.breakdown && <p className="mt-1 text-[9px] font-medium text-slate-400 italic">{item.breakdown}</p>}
                  </div>
                );
              }
              return null;
            }}
          />
          <Bar dataKey="val" radius={[4, 4, 0, 0]}>
            {data.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={color}
                opacity={activeValue && activeValue === entry.name ? 1 : (activeValue ? 0.3 : 1)}
                cursor="pointer"
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
