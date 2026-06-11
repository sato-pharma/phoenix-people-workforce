"use client";

import { AlertTriangle, ChevronRight, Database, Map as MapIcon, Package, ShieldAlert, Truck, Users } from "lucide-react";
import Link from "next/link";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { SiDeltaBadge } from "@/components/sales/intelligence/si-delta-badge";
import { compactEGP, shareText } from "@/components/sales/intelligence/si-format";
import type { SiConcentration, SiInsight, SiKpiSummary } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

const CATEGORY_STYLE: Record<SiInsight["category"], { tone: string; icon: typeof Package }> = {
  products: { tone: "bg-violet-500/20 text-violet-300", icon: Package },
  distributors: { tone: "bg-orange-500/20 text-orange-300", icon: Truck },
  geography: { tone: "bg-blue-500/20 text-blue-300", icon: MapIcon },
  customers: { tone: "bg-amber-500/20 text-amber-300", icon: Users },
  risk: { tone: "bg-rose-500/20 text-rose-300", icon: ShieldAlert },
  coverage: { tone: "bg-emerald-500/20 text-emerald-300", icon: MapIcon },
};

function scrollToAnchor(anchor: string) {
  const target = document.querySelector(anchor);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Dark EXECUTIVE SIGNALS rail — computed narratives only (a missing baseline omits its insight,
// it never fabricates one). Sits beside the Daily Rhythm chart.
export function SiInsightRail({ insights }: { insights: SiInsight[] }) {
  return (
    <section className="flex h-full flex-col border border-[#1a1a1a] bg-[#0B0B0B] p-5">
      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-orange-300">Executive Signals</p>
      <div className="mt-4 flex-1 space-y-4">
        {insights.length === 0 ? (
          <p className="text-xs font-bold text-slate-500">No signals yet — upload a validated month.</p>
        ) : (
          insights.map((insight) => {
            const style = CATEGORY_STYLE[insight.category];
            const Icon = style.icon;
            return (
              <button
                className="group flex w-full items-start gap-3 text-left"
                key={`${insight.category}:${insight.headline}`}
                onClick={() => scrollToAnchor(insight.anchor)}
                type="button"
              >
                <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center", style.tone)}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[11px] font-black text-white transition group-hover:text-orange-300">{insight.headline}</span>
                    {insight.deltaPct !== undefined && <SiDeltaBadge pct={insight.deltaPct} surface="dark" />}
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] font-bold text-slate-400">{insight.detail}</span>
                </span>
                <ChevronRight className="mt-1.5 h-3.5 w-3.5 shrink-0 text-slate-600 transition group-hover:text-orange-300" />
              </button>
            );
          })
        )}
      </div>
      <p className="mt-4 border-t border-white/10 pt-3 text-[9px] font-bold uppercase tracking-[0.16em] text-slate-600">
        Computed from scoped data only — never fabricated
      </p>
    </section>
  );
}

// The closing "so what do I worry about" band: white-space, concentration, completeness.
export function SiRisksBand({
  kpis,
  concentration,
  customerTop10Share,
  zeroSalesAreas,
  topDistributor,
  period,
}: {
  kpis: SiKpiSummary;
  concentration: SiConcentration;
  customerTop10Share: number | null;
  zeroSalesAreas: string[];
  topDistributor: { name: string; share: number; value: number } | null;
  period: string | null;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-3" id="risks">
      <AdminCallout tone={zeroSalesAreas.length > 0 ? "warning" : "success"}>
        <MapIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold">White space</p>
          <p className="mt-1 text-sm">
            {zeroSalesAreas.length === 0
              ? "Every mapped area recorded sales this month."
              : `${zeroSalesAreas.length} areas with zero sales: ${zeroSalesAreas.slice(0, 5).join(", ")}${zeroSalesAreas.length > 5 ? "…" : ""}`}
          </p>
        </div>
      </AdminCallout>
      <AdminCallout tone={concentration.distributors.band === "high" || (customerTop10Share ?? 0) > 0.5 ? "danger" : "neutral"}>
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold">Concentration</p>
          <p className="mt-1 text-sm">
            {topDistributor
              ? `${topDistributor.name} carries ${shareText(topDistributor.share)} (EGP ${compactEGP(topDistributor.value)}). `
              : ""}
            {customerTop10Share !== null ? `Top-10 customers hold ${shareText(customerTop10Share, 0)} of value.` : "Customer concentration loading…"}
          </p>
        </div>
      </AdminCallout>
      <AdminCallout tone={kpis.monthComplete ? "success" : "warning"}>
        <Database className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold">Data completeness</p>
          <p className="mt-1 text-sm">
            {kpis.monthComplete
              ? `${period ?? "This month"} is complete — every expected distributor uploaded.`
              : `${period ?? "This month"} is missing: ${kpis.missingDistributors.join(", ") || "—"}.`}{" "}
            <Link className="font-bold text-[#F97316] underline-offset-2 hover:underline" href="/sales-intelligence/data-quality">
              Data Quality Center →
            </Link>
          </p>
        </div>
      </AdminCallout>
    </div>
  );
}
