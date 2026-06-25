"use client";

import { TrendingUp, TrendingDown, Minus } from "lucide-react";

type Props = {
  label: string;
  value: string;
  subValue?: string;
  growth?: number | null;
  prefix?: string;
  className?: string;
};

export function AnalyticsKpiCard({ label, value, subValue, growth, prefix, className }: Props) {
  const growthSign = growth == null ? null : growth > 0 ? "up" : growth < 0 ? "down" : "flat";

  return (
    <div className={`border border-border border-l-4 border-l-[#F97316] bg-card flex flex-col overflow-hidden ${className ?? ""}`}>
      <div className="bg-[#0F172A] px-3 py-1.5">
        <p className="text-[10px] text-white/70 uppercase tracking-widest font-semibold truncate">{label}</p>
      </div>
      <div className="px-4 py-3 flex flex-col gap-1.5 flex-1">
        <p className="text-3xl font-bold text-foreground tabular-nums leading-none">
          {prefix && <span className="text-sm font-normal text-muted-foreground mr-1">{prefix}</span>}
          {value}
        </p>
        {subValue && <p className="text-xs text-muted-foreground">{subValue}</p>}
        {growthSign != null && (
          <div className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 self-start ${
            growthSign === "up"
              ? "bg-emerald-900/20 text-emerald-600"
              : growthSign === "down"
              ? "bg-red-900/20 text-red-500"
              : "bg-muted text-muted-foreground"
          }`}>
            {growthSign === "up" && <TrendingUp className="h-3 w-3" />}
            {growthSign === "down" && <TrendingDown className="h-3 w-3" />}
            {growthSign === "flat" && <Minus className="h-3 w-3" />}
            <span>{growth != null ? `${growth > 0 ? "+" : ""}${growth.toFixed(1)}% vs prior` : ""}</span>
          </div>
        )}
      </div>
    </div>
  );
}
