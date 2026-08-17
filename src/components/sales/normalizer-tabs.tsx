"use client";

import { useState } from "react";
import { History } from "lucide-react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { NormalizerWorkspace } from "@/components/sales/normalizer-workspace";
import { WeeklyNormalizationTab } from "@/components/sales/weekly/weekly-normalization-tab";
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
// The two tabs now run the SAME loop: drop the raw distributor file, see how much of it auto-codes,
// map what the dictionary has never seen, watch coverage climb. Weekly keeps one extra panel the
// monthly side has no equivalent of — the backlog of item codes left behind by weekly uploads that
// already happened, which is fixed by looking at the dictionary rather than at a file.
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
        <div className="space-y-6">
          <WeeklyNormalizerWorkspace aiEnabled={aiEnabled} distributors={weeklyDistributors} references={weeklyReferences} />
          <AdminTableShell
            action={<span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500"><History className="h-3.5 w-3.5" />From uploads already in Phoenix</span>}
            description="Item codes that came in on past weekly uploads and still have no Phoenix product. This is the leftover backlog — nothing here needs a file; pick the product and it is remembered for every future upload."
            title="Unmapped items from past weekly uploads"
          >
            <div className="p-4 md:p-5">
              <WeeklyNormalizationTab aiEnabled={aiEnabled} products={references.products} />
            </div>
          </AdminTableShell>
        </div>
      )}
    </div>
  );
}
