"use client";

import { ChevronRight, EyeOff, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

import { SiDeltaBadge } from "@/components/sales/intelligence/si-delta-badge";
import { compactEGP, compactNumber } from "@/components/sales/intelligence/si-format";
import { periodProseLabel } from "@/lib/sales/periods";
import type { SiAccessBadge, SiCompare, SiInsight, SiKpiSummary } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

const CATEGORY_TONE: Record<SiInsight["category"], string> = {
  products: "bg-violet-100 text-violet-600",
  distributors: "bg-orange-100 text-orange-600",
  geography: "bg-blue-100 text-blue-600",
  customers: "bg-amber-100 text-amber-600",
  risk: "bg-rose-100 text-rose-600",
  coverage: "bg-emerald-100 text-emerald-600",
};

function scrollToAnchor(anchor: string) {
  const target = document.querySelector(anchor);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
}

function Metric({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="border-l border-[#E7D9C8] pl-4 first:border-l-0 first:pl-0">
      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#94A3B8]">{label}</p>
      <p className="mt-0.5 text-2xl font-black tracking-tight text-[#0F172A]">{value}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

// Compact, light executive header — a slim band, not a tall block. Identity + headline metrics
// on one row; signal chips on a thin strip below.
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
    <section className="overflow-hidden border border-[#E7D9C8] bg-gradient-to-r from-white via-[#FFFBF6] to-[#FFF3E6] px-5 py-4 shadow-[0_8px_28px_rgba(15,23,42,0.05)]">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        {/* Left: identity */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center rounded-full border border-orange-300 bg-orange-100 px-3 py-1 text-[11px] font-black uppercase tracking-[0.14em] text-orange-700">
              Executive Intelligence
            </span>
            <h1 className="text-2xl font-black tracking-[-0.02em] text-[#0F172A] sm:text-3xl">
              <span className="text-[#F97316]">{periodProseLabel(period)}</span> Performance
            </h1>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className={cn(
              "rounded-full border px-3 py-1 text-[11px] font-black uppercase tracking-[0.1em]",
              kpis.monthComplete ? "border-emerald-300 bg-emerald-100 text-emerald-700" : "border-amber-300 bg-amber-100 text-amber-700",
            )}>
              {kpis.monthComplete ? "Complete month" : `Incomplete · missing ${kpis.missingDistributors.length}`}
            </span>
            {!access.canViewAllSales && access.lineNames.length > 0 && (
              <span className="rounded-full border border-[#E2E8F0] bg-white px-3 py-1 text-[11px] font-black uppercase tracking-[0.1em] text-[#334155]">Line: {access.lineNames.join(", ")}</span>
            )}
            {!access.canViewAllSales && access.regionNames.length > 0 && (
              <span className="rounded-full border border-[#E2E8F0] bg-white px-3 py-1 text-[11px] font-black uppercase tracking-[0.1em] capitalize text-[#334155]">Region: {access.regionNames.join(", ")}</span>
            )}
            {access.restrictedIncluded ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-300 bg-rose-100 px-3 py-1 text-[11px] font-black uppercase tracking-[0.1em] text-rose-700"><ShieldAlert className="h-3 w-3" /> Incl. Lacto Basic</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white px-3 py-1 text-[11px] font-black uppercase tracking-[0.1em] text-[#64748B]"><EyeOff className="h-3 w-3" /> Restricted excluded</span>
            )}
          </div>
        </div>

        {/* Right: headline metric strip */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-3 border-t border-[#F1E6D6] pt-3 xl:border-0 xl:pt-0">
          <Metric label="Net Sales" value={<><span className="text-base font-bold text-[#94A3B8]">EGP</span> {compactEGP(kpis.totals.value)}</>}>
            <div className="flex items-center gap-3">
              <SiDeltaBadge label="MoM" pct={compare.value.mom.pct} />
              <SiDeltaBadge label="YoY" pct={compare.value.yoy.pct} />
            </div>
          </Metric>
          <Metric label="Units" value={compactNumber(kpis.totals.units)}>
            <SiDeltaBadge label="MoM" pct={compare.units.mom.pct} />
          </Metric>
          <Metric label="Customers" value={customerPending ? <span className="animate-pulse text-[#CBD5E1]">···</span> : compactNumber(customerCount ?? 0)}>
            <span className="text-[11px] font-bold text-[#94A3B8]">this month</span>
          </Metric>
        </div>
      </div>

      {/* Thin signals strip */}
      {insights.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-[#F1E6D6] pt-3">
          {insights.slice(0, 3).map((insight) => (
            <button
              className="group inline-flex max-w-full items-center gap-2 rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-left transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]"
              key={insight.headline}
              onClick={() => scrollToAnchor(insight.anchor)}
              type="button"
            >
              <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-black", CATEGORY_TONE[insight.category])}>●</span>
              <span className="truncate text-[12px] font-bold text-[#334155]">{insight.headline}</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#CBD5E1] transition group-hover:text-[#F97316]" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
