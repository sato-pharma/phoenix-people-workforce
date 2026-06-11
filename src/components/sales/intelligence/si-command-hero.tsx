"use client";

import { ChevronRight, EyeOff, ShieldAlert } from "lucide-react";

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
  products: "bg-violet-500/20 text-violet-200",
  distributors: "bg-orange-500/20 text-orange-200",
  geography: "bg-blue-500/20 text-blue-200",
  customers: "bg-amber-500/20 text-amber-200",
  risk: "bg-rose-500/20 text-rose-200",
  coverage: "bg-emerald-500/20 text-emerald-200",
};

function scrollToAnchor(anchor: string) {
  const target = document.querySelector(anchor);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
}

// The dark command surface — answers "how are we doing?" in three seconds: one cinematic hero
// with the period as prose, the top auto-signals, and the headline number block with MoM/YoY.
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
    <section className={cn(adminHeroSurfaceClassName, "p-5 sm:p-7")}>
      <div aria-hidden="true" className={adminHeroGridOverlayClassName} />
      <div aria-hidden="true" className={adminHeroGlowOrangeClassName} />
      <div aria-hidden="true" className={adminHeroGlowAmberClassName} />
      <div aria-hidden="true" className={adminHeroAccentBarClassName} />

      <div className="relative grid gap-6 lg:grid-cols-12">
        {/* Left: identity + signals */}
        <div className="min-w-0 lg:col-span-7">
          <span className={adminHeroKickerClassName}>Source of Sales — Executive Intelligence</span>
          <h1 className="mt-4 max-w-4xl text-[1.6rem] font-black tracking-[-0.04em] text-white sm:text-[1.9rem] lg:text-[2.1rem]">
            {periodProseLabel(period)} Performance
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
            Distributor-sourced sales, scoped to your line and region, shown by name. Every comparison is
            computed from real baselines — a dash means the baseline month is not imported yet.
          </p>

          {/* Top auto-signals — each deep-links to its section */}
          <div className="mt-5 flex flex-wrap gap-2">
            {insights.slice(0, 3).map((insight) => (
              <button
                className="group inline-flex max-w-full items-center gap-2 border border-white/15 bg-white/[0.07] px-3 py-1.5 text-left backdrop-blur transition hover:border-orange-400/50 hover:bg-white/[0.12]"
                key={insight.headline}
                onClick={() => scrollToAnchor(insight.anchor)}
                type="button"
              >
                <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-black", CATEGORY_TONE[insight.category])}>
                  ●
                </span>
                <span className="truncate text-[11px] font-bold text-slate-200">{insight.headline}</span>
                <ChevronRight className="h-3 w-3 shrink-0 text-slate-500 transition group-hover:text-orange-300" />
              </button>
            ))}
          </div>

          {/* Bottom badges: completeness, scope, restricted state */}
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <span className={cn(
              "rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-[0.14em] backdrop-blur",
              kpis.monthComplete
                ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                : "border-amber-400/40 bg-amber-500/15 text-amber-200",
            )}>
              {kpis.monthComplete ? "Complete month" : `Incomplete · missing ${kpis.missingDistributors.length}`}
            </span>
            {!access.canViewAllSales && access.lineNames.length > 0 && (
              <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-slate-200 backdrop-blur">
                Line: {access.lineNames.join(", ")}
              </span>
            )}
            {!access.canViewAllSales && access.regionNames.length > 0 && (
              <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.14em] capitalize text-slate-200 backdrop-blur">
                Region: {access.regionNames.join(", ")}
              </span>
            )}
            {access.restrictedIncluded ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-400/40 bg-rose-500/15 px-3 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-rose-200 backdrop-blur">
                <ShieldAlert className="h-3 w-3" /> Including Lacto Basic 1 &amp; 2
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-slate-300 backdrop-blur">
                <EyeOff className="h-3 w-3" /> Restricted products excluded
              </span>
            )}
          </div>
        </div>

        {/* Right: the headline number block */}
        <div className="space-y-3 lg:col-span-5">
          <div className="border border-white/10 bg-white/[0.06] p-4 backdrop-blur">
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-orange-200">Net Sales</p>
            <p className="mt-1 text-4xl font-black tabular-nums text-white xl:text-5xl">
              EGP {compactEGP(kpis.totals.value)}
            </p>
            <div className="mt-2 flex items-center gap-4">
              <SiDeltaBadge label="MoM" pct={compare.value.mom.pct} surface="dark" />
              <SiDeltaBadge label="YoY" pct={compare.value.yoy.pct} surface="dark" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="border border-white/10 bg-white/[0.06] p-4 backdrop-blur">
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-400">Units</p>
              <p className="mt-1 text-2xl font-black tabular-nums text-white">{compactNumber(kpis.totals.units)}</p>
              <div className="mt-1.5">
                <SiDeltaBadge label="MoM" pct={compare.units.mom.pct} surface="dark" />
              </div>
            </div>
            <div className="border border-white/10 bg-white/[0.06] p-4 backdrop-blur">
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-400">Active Customers</p>
              <p className="mt-1 text-2xl font-black tabular-nums text-white">
                {customerPending ? <span className="animate-pulse text-slate-500">···</span> : compactNumber(customerCount ?? 0)}
              </p>
              <p className="mt-1.5 text-[10px] font-bold text-slate-500">buying this month</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
