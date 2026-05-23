"use client";

import { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Tone = "orange" | "emerald" | "blue" | "slate" | "rose" | "violet";

const toneClasses: Record<Tone, { border: string; icon: string; line: string; text: string }> = {
  blue: {
    border: "border-sky-100",
    icon: "bg-sky-50 text-sky-700 ring-1 ring-sky-200/50",
    line: "bg-sky-500",
    text: "text-sky-600",
  },
  emerald: {
    border: "border-emerald-100",
    icon: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/50",
    line: "bg-emerald-500",
    text: "text-emerald-600",
  },
  orange: {
    border: "border-orange-100",
    icon: "bg-orange-50 text-orange-700 ring-1 ring-orange-200/50",
    line: "bg-orange-500",
    text: "text-orange-600",
  },
  rose: {
    border: "border-red-100",
    icon: "bg-red-50 text-red-700 ring-1 ring-red-200/50",
    line: "bg-red-500",
    text: "text-red-600",
  },
  slate: {
    border: "border-slate-100",
    icon: "bg-slate-50 text-slate-700 ring-1 ring-slate-200/50",
    line: "bg-slate-500",
    text: "text-slate-600",
  },
  violet: {
    border: "border-violet-100",
    icon: "bg-violet-50 text-violet-700 ring-1 ring-violet-200/50",
    line: "bg-violet-500",
    text: "text-violet-600",
  },
};

type KPICardProps = {
  icon: LucideIcon;
  label: string;
  value: string;
  delta: string;
  spark: number[];
  tone?: Tone;
  className?: string;
};

export function KPICard({ icon: Icon, label, value, delta, spark, tone = "orange", className }: KPICardProps) {
  const toneStyle = toneClasses[tone];
  const max = Math.max(...spark, 1);

  return (
    <Card className={cn("group overflow-hidden rounded-2xl border-2 bg-white p-0 shadow-[0_4px_12px_rgba(15,23,42,0.05)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_8px_20px_rgba(15,23,42,0.08)]", toneStyle.border, className)}>
      <div className={cn("h-1.5 transition-all duration-300 group-hover:h-2", toneStyle.line)} />
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-600">{label}</p>
            <p className="mt-2 truncate text-3xl font-black text-slate-950">{value}</p>
          </div>
          <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-110", toneStyle.icon)}>
            <Icon className="h-5 w-5" />
          </span>
        </div>
        <div className="mt-5 flex h-10 items-end gap-1">
          {spark.map((item, index) => (
            <span
              className={cn("flex-1 rounded-t-sm transition-opacity opacity-70 group-hover:opacity-90", toneStyle.line)}
              key={`${item}-${index}`}
              style={{ height: `${Math.max((item / max) * 100, 12)}%` }}
            />
          ))}
        </div>
        <p className={cn("mt-4 text-xs font-bold", toneStyle.text)}>{delta}</p>
      </div>
    </Card>
  );
}
