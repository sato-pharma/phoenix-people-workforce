"use client";

import { useState } from "react";

import { NormalizerWorkspace } from "@/components/sales/normalizer-workspace";
import { WeeklyNormalizerWorkspace, type WeeklyNormalizerDistributor, type WeeklyNormalizerReferences } from "@/components/sales/weekly/weekly-normalizer-workspace";
import { cn } from "@/lib/utils";

type DistributorOption = { code: string; name: string };
type MappingReferences = { bricks: { id: string; name: string }[]; products: { code: string; name: string }[] };

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={cn("border px-4 py-2 text-sm font-black uppercase tracking-wide transition", active ? "border-slate-900 bg-slate-900 text-white" : "border-transparent text-slate-500 hover:border-slate-200 hover:bg-slate-50 hover:text-slate-900")} onClick={onClick} type="button">{children}</button>
  );
}

// Source Normalizer with Monthly / Weekly tabs — both AI-assisted, both writing to the same shared
// mapping dictionary the uploads read.
//
// Both tabs run the SAME loop: drop the raw distributor file, see how much of it auto-codes, map
// what the dictionary has never seen, watch coverage climb.
//
// Weekly used to carry an extra "backlog" panel below this, listing item codes left unmapped by past
// weekly uploads. It read stored rows with validation_state='warning' — a state weekly validation
// never produces, since any failure blocks the whole batch and nothing persists — so the backlog was
// always empty. Removed 2026-08-21; unmapped labels surface in the preview above, before storage.
export function NormalizerTabs({
  aiEnabled,
  distributors,
  references,
  weeklyDistributors,
  weeklyReferences,
}: {
  aiEnabled: boolean;
  distributors: DistributorOption[];
  references: MappingReferences;
  weeklyDistributors: WeeklyNormalizerDistributor[];
  weeklyReferences: WeeklyNormalizerReferences;
}) {
  const [tab, setTab] = useState<"monthly" | "weekly">("monthly");
  return (
    <div className="space-y-4">
      <div className="inline-flex gap-1 border border-slate-200 bg-white p-1 shadow-sm">
        <TabButton active={tab === "monthly"} onClick={() => setTab("monthly")}>Monthly Normalization</TabButton>
        <TabButton active={tab === "weekly"} onClick={() => setTab("weekly")}>Weekly Normalization</TabButton>
      </div>
      {tab === "monthly" ? (
        <NormalizerWorkspace aiEnabled={aiEnabled} distributors={distributors} references={references} />
      ) : (
        <WeeklyNormalizerWorkspace aiEnabled={aiEnabled} distributors={weeklyDistributors} references={weeklyReferences} />
      )}
    </div>
  );
}
