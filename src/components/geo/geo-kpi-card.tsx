"use client";

import type { LucideIcon } from "lucide-react";

import { Card } from "@/components/ui/card";

const panelClassName =
  "rounded-[28px] border border-[#D8E0EA] bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";

export function GeoKpiCard({
  helper,
  icon: Icon,
  label,
  tone = "orange",
  value,
}: {
  helper: string;
  icon: LucideIcon;
  label: string;
  tone?: "amber" | "orange" | "red" | "slate";
  value: string;
}) {
  const toneClass = {
    amber: "bg-amber-50 text-amber-600 ring-amber-200/60",
    orange: "bg-orange-50 text-orange-600 ring-orange-200/60",
    red: "bg-red-50 text-red-600 ring-red-200/60",
    slate: "bg-slate-100 text-slate-600 ring-slate-200/70",
  }[tone];

  return (
    <Card className={`${panelClassName} p-4 transition-transform duration-200 hover:-translate-y-0.5`}>
      <div className="flex items-start gap-3">
        <span className={`mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ring-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] ${toneClass}`}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
            {label}
          </p>
          <p className="mt-1 truncate text-2xl font-black text-slate-950">{value}</p>
          <p className="mt-1 text-xs font-medium text-slate-500">{helper}</p>
        </div>
      </div>
    </Card>
  );
}
