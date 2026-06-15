"use client";

import { ShieldAlert } from "lucide-react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import type { ExpenseRiskLocationRow } from "@/components/outstation/expense-shared/types";

export function ExpenseRiskPanel({
  highRiskByLocation,
  highRiskRows,
  onSelectRegion,
}: {
  highRiskByLocation: ExpenseRiskLocationRow[] | null;
  highRiskRows: number | null;
  onSelectRegion?: (region: string) => void;
}) {
  const rows = highRiskByLocation ?? [];
  const total = highRiskRows ?? 0;

  return (
    <AdminTableShell
      title="Risk & fraud signals"
      description="Trips flagged by territory mismatch, GPS suspicion, or rejection recommendation."
      action={
        <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-bold text-rose-700">
          <ShieldAlert className="h-3.5 w-3.5" /> {total.toLocaleString()} flagged
        </span>
      }
    >
      <div className="p-5">
        {total === 0 || rows.length === 0 ? (
          <AdminCallout tone="success">
            <span>No high-risk outstation trips in the current view. Territory and GPS checks are clean.</span>
          </AdminCallout>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.label}>
                <button
                  type="button"
                  onClick={() => onSelectRegion?.(row.label)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-rose-100 bg-rose-50/60 px-4 py-3 text-left transition-colors hover:border-rose-300"
                >
                  <span className="truncate text-sm font-semibold text-slate-800">{row.label}</span>
                  <span className="shrink-0 rounded-full bg-rose-600 px-2.5 py-0.5 text-xs font-black text-white">
                    {row.highRiskTrips} flagged
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminTableShell>
  );
}
