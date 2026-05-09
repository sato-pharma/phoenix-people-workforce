"use client";

import type { OutstationTerritoryValidationStatus } from "@/lib/outstation/types";
import { Card } from "@/components/ui/card";

function tone(status: OutstationTerritoryValidationStatus) {
  if (status === "matched") return "bg-emerald-50 text-emerald-700 ring-emerald-100";
  if (status === "outside_expected_territory") {
    return "bg-amber-50 text-amber-700 ring-amber-100";
  }
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

export function TerritoryValidationPanel({
  reason,
  status,
}: {
  reason: string;
  status: OutstationTerritoryValidationStatus;
}) {
  return (
    <Card className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
        Territory Validation
      </p>
      <div className="mt-3">
        <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.14em] ring-1 ${tone(status)}`}>
          {status.replace(/_/g, " ")}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-600">{reason || "No territory validation notes were recorded."}</p>
    </Card>
  );
}
