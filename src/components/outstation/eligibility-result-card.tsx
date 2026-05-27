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
    <Card className="rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="rounded-md bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">
            Step 2 result
          </span>
          <h2 className="mt-2 text-base font-bold text-slate-800 sm:text-lg">
            Eligibility and approval intelligence
          </h2>
        </div>
        <ApprovalRecommendationBadge value={result.approvalRecommendation} />
      </div>

      <div className="mt-4 grid grid-cols-1 divide-x divide-y divide-gray-100 overflow-hidden rounded-md border border-gray-100 sm:grid-cols-2 xl:grid-cols-4">
        <Info
          accent="border-l-sky-400"
          label="Distance"
          value={
            result.distanceFromResidenceKm != null
              ? `${result.distanceFromResidenceKm.toFixed(2)} KM`
              : "N/A"
          }
        />
        <Info
          accent="border-l-amber-400"
          label="Duration"
          value={
            result.durationMinutes != null
              ? `${result.durationMinutes.toFixed(0)} mins`
              : "N/A"
          }
        />
        <Info
          accent="border-l-emerald-400"
          label="Eligible"
          value={result.eligibilityStatus.replace(/_/g, " ")}
        />
        <Info accent="border-l-orange-400" label="Reason" value={result.eligibilityReason} />
      </div>
      {result.routeError ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-800">
          <span className="font-semibold">Route API:</span> {result.routeError}
        </div>
      ) : null}
      <p className="mt-3 text-[13px] leading-relaxed text-slate-500">
        {result.approvalReason}
      </p>
    </Card>
  );
}

function Info({
  accent,
  label,
  value,
}: {
  accent: string;
  label: string;
  value: string;
}) {
  return (
    <div className={`border-l-2 ${accent} px-3 py-3`}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p
        className="mt-1 truncate text-[13px] font-semibold capitalize text-slate-800"
        title={value}
      >
        {value}
      </p>
    </div>
  );
}
