"use client";

import { Card } from "@/components/ui/card";
import type { OutstationCalculationResult } from "@/lib/outstation/types";
import { ApprovalRecommendationBadge } from "@/components/outstation/approval-recommendation-badge";

export function EligibilityResultCard({
  result,
}: {
  result: OutstationCalculationResult | null;
}) {
  if (!result) return null;

  return (
    <Card className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
            Step 2 Result
          </p>
          <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-slate-950">
            Eligibility and approval intelligence
          </h2>
        </div>
        <ApprovalRecommendationBadge value={result.approvalRecommendation} />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Info label="Distance" value={result.distanceFromResidenceKm != null ? `${result.distanceFromResidenceKm.toFixed(2)} KM` : "N/A"} />
        <Info label="Duration" value={result.durationMinutes != null ? `${result.durationMinutes.toFixed(0)} mins` : "N/A"} />
        <Info label="Eligible" value={result.eligibilityStatus.replace(/_/g, " ")} />
        <Info label="Reason" value={result.eligibilityReason} />
      </div>
      {result.routeError ? (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-semibold">Route API:</span> {result.routeError}
        </div>
      ) : null}
      <p className="mt-4 text-sm leading-6 text-slate-600">{result.approvalReason}</p>
    </Card>
  );
}

function Info({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
