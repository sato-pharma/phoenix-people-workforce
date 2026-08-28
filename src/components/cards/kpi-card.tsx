"use client";

import { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Tone = "orange" | "emerald" | "blue" | "slate" | "rose" | "violet";

const toneClasses: Record<Tone, { border: string; icon: string; line: string; text: string }> = {
  blue: {
    border: "border-phx-line",
    icon: "bg-phx-paper text-phx-ink",
    line: "bg-[#3B82F6]",
    text: "text-phx-ink",
  },
  emerald: {
    border: "border-phx-line",
    icon: "bg-phx-paper text-[#22C55E]",
    line: "bg-[#22C55E]",
    text: "text-[#22C55E]",
  },
  orange: {
    border: "border-phx-line",
    icon: "bg-phx-paper text-phx-accent",
    line: "bg-phx-accent",
    text: "text-phx-accent",
  },
  rose: {
    border: "border-phx-line",
    icon: "bg-phx-paper text-[#EF4444]",
    line: "bg-[#EF4444]",
    text: "text-[#EF4444]",
  },
  slate: {
    border: "border-phx-line",
    icon: "bg-phx-paper text-phx-ink",
    line: "bg-phx-ink-soft",
    text: "text-phx-ink-soft",
  },
  violet: {
    border: "border-phx-line",
    icon: "bg-phx-paper text-[#8B5CF6]",
    line: "bg-[#8B5CF6]",
    text: "text-[#8B5CF6]",
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
    <Card className={cn("overflow-hidden rounded-2xl border bg-white p-0 shadow-[0_8px_20px_rgba(15,23,42,0.04)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_28px_rgba(15,23,42,0.08)]", toneStyle.border, className)}>
      <div className={cn("h-1", toneStyle.line)} />
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-phx-ink-soft">{label}</p>
            <p className="mt-1 truncate text-2xl font-black text-phx-ink">{value}</p>
          </div>
          <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", toneStyle.icon)}>
            <Icon className="h-5 w-5" />
          </span>
        </div>
        <div className="mt-4 flex h-9 items-end gap-1">
          {spark.map((item, index) => (
            <span
              className={cn("flex-1 rounded-t-sm opacity-80", toneStyle.line)}
              key={`${item}-${index}`}
              style={{ height: `${Math.max((item / max) * 100, 12)}%` }}
            />
          ))}
        </div>
        <p className={cn("mt-3 text-xs font-black", toneStyle.text)}>{delta}</p>
      </div>
    </Card>
  );
}
