"use client";

import { EyeOff, ShieldAlert } from "lucide-react";

import {
  adminHeroAccentBarClassName,
  adminHeroGlowAmberClassName,
  adminHeroGlowOrangeClassName,
  adminHeroGridOverlayClassName,
  adminHeroKickerClassName,
  adminHeroSurfaceClassName,
} from "@/components/admin/admin-design-tokens";
import { SiDeltaBadge } from "@/components/sales/intelligence/si-delta-badge";
import { compactEGP, compactNumber } from "@/components/sales/intelligence/si-format";
import { periodProseLabel } from "@/lib/sales/periods";
import type { SiAccessBadge, SiCompare, SiInsight, SiKpiSummary } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

const CATEGORY_TONE: Record<SiInsight["category"], string> = {
  products: "bg-violet-400",
  distributors: "bg-orange-400",
  geography: "bg-blue-400",
  customers: "bg-amber-400",
  risk: "bg-rose-400",
  coverage: "bg-emerald-400",
};

function scrollToAnchor(anchor: string) {
  const target = document.querySelector(anchor);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
}

// The dark command surface, compact: identity on the left, the headline numbers inline on the
// right, and a single thin signal/scope strip below. No tall paragraph, no stacked number cards —
// the band stays as slim as possible.
export function SiCommandHero({
  period,
  kpis,
  compare,
  access,
  insights,
  customerCount,
  customerPending,
}: {
  period: string | null;
  kpis: SiKpiSummary;
  compare: SiCompare;
  access: SiAccessBadge;
  insights: SiInsight[];
  customerCount: number | null;
  customerPending: boolean;
}) {
  return (
    <section className={cn(adminHeroSurfaceClassName, "p-3 sm:p-4")}>
      <div aria-hidden="true" className={adminHeroGridOverlayClassName} />
      <div aria-hidden="true" className={adminHeroGlowOrangeClassName} />
      <div aria-hidden="true" className={adminHeroGlowAmberClassName} />
      <div aria-hidden="true" className={adminHeroAccentBarClassName} />

      <div className="relative flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {/* Left: identity */}
        <div className="min-w-0">
          <span className={adminHeroKickerClassName}>Source of Sales — Executive Intelligence</span>
          <h1 className="mt-1 truncate text-lg font-black tracking-[-0.03em] text-white sm:text-xl">
            {periodProseLabel(period)} Performance
          </h1>
        </div>

        {/* Right: headline numbers, inline */}
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div className="min-w-0">
            <p className="text-[9px] font-black uppercase tracking-[0.22em] text-orange-200">Net Sales</p>
            <p className="text-2xl font-black leading-none tabular-nums text-white sm:text-[1.7rem]">
              EGP {compactEGP(kpis.totals.value)}
            </p>
            <div className="mt-1 flex items-center gap-3">
              <SiDeltaBadge label="MoM" pct={compare.value.mom.pct} surface="dark" />
              <SiDeltaBadge label="YoY" pct={compare.value.yoy.pct} surface="dark" />
            </div>
          </div>
          <div className="min-w-0">
            <p className="text-[9px] font-black uppercase tracking-[0.22em] text-slate-400">Units</p>
            <p className="text-xl font-black leading-none tabular-nums text-white">{compactNumber(kpis.totals.units)}</p>
            <div className="mt-1"><SiDeltaBadge label="MoM" pct={compare.units.mom.pct} surface="dark" /></div>
          </div>
          <div className="min-w-0">
            <p className="text-[9px] font-black uppercase tracking-[0.22em] text-slate-400">Active Customers</p>
            <p className="text-xl font-black leading-none tabular-nums text-white">
              {customerPending ? <span className="animate-pulse text-slate-500">···</span> : compactNumber(customerCount ?? 0)}
            </p>
            <p className="mt-1 text-[9px] font-bold text-slate-500">buying this month</p>
          </div>
        </div>
      </div>

      {/* Single thin strip: completeness, scope, restricted state, top signals */}
      <div className="relative mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className={cn(
          "rounded-full border px-2.5 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] backdrop-blur",
          kpis.monthComplete
            ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
            : "border-amber-400/40 bg-amber-500/15 text-amber-200",
        )}>
          {kpis.monthComplete ? "Complete month" : `Incomplete · missing ${kpis.missingDistributors.length}`}
        </span>
        {access.restrictedIncluded ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-rose-400/40 bg-rose-500/15 px-2.5 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] text-rose-200 backdrop-blur">
            <ShieldAlert className="h-3 w-3" /> Including Lacto Basic 1 &amp; 2
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2.5 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] text-slate-300 backdrop-blur">
            <EyeOff className="h-3 w-3" /> Restricted excluded
          </span>
        )}
        {!access.canViewAllSales && access.lineNames.length > 0 && (
          <span className="rounded-full border border-white/15 bg-white/10 px-2.5 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] text-slate-200 backdrop-blur">
            Line: {access.lineNames.join(", ")}
          </span>
        )}
        {!access.canViewAllSales && access.regionNames.length > 0 && (
          <span className="rounded-full border border-white/15 bg-white/10 px-2.5 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] capitalize text-slate-200 backdrop-blur">
            Region: {access.regionNames.join(", ")}
          </span>
        )}
        {insights.slice(0, 2).map((insight) => (
          <button
            className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.07] px-2.5 py-0.5 text-left backdrop-blur transition hover:border-orange-400/50 hover:bg-white/[0.12]"
            key={insight.headline}
            onClick={() => scrollToAnchor(insight.anchor)}
            type="button"
          >
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", CATEGORY_TONE[insight.category])} />
            <span className="truncate text-[10px] font-bold text-slate-200">{insight.headline}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
