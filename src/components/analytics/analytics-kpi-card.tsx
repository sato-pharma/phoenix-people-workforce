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
    <div className={`border border-border bg-card p-4 flex flex-col gap-1 ${className ?? ""}`}>
      <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">{label}</p>
      <p className="text-2xl font-bold text-foreground tabular-nums">
        {prefix && <span className="text-base font-normal mr-0.5">{prefix}</span>}
        {value}
      </p>
      {subValue && <p className="text-xs text-muted-foreground">{subValue}</p>}
      {growthSign != null && (
        <div className={`flex items-center gap-1 text-xs mt-1 ${
          growthSign === "up" ? "text-emerald-600" : growthSign === "down" ? "text-red-500" : "text-muted-foreground"
        }`}>
          {growthSign === "up" && <TrendingUp className="h-3 w-3" />}
          {growthSign === "down" && <TrendingDown className="h-3 w-3" />}
          {growthSign === "flat" && <Minus className="h-3 w-3" />}
          <span>{growth != null ? `${growth > 0 ? "+" : ""}${growth.toFixed(1)}%` : ""}</span>
        </div>
      )}
    </div>
  );
}
