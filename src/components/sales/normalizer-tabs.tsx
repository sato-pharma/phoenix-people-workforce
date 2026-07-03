"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { NormalizerWorkspace } from "@/components/sales/normalizer-workspace";
import { WeeklyNormalizationTab } from "@/components/sales/weekly/weekly-normalization-tab";
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
export function NormalizerTabs({ aiEnabled, distributors, references }: { aiEnabled: boolean; distributors: DistributorOption[]; references: MappingReferences }) {
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
        <div className="space-y-5">
          <AdminPageHero
            description="Map the weekly item codes that don't resolve to a Phoenix product — AI-assisted, saved to the same dictionary every weekly upload reads."
            eyebrow="Sales · One connected module"
            icon={<Sparkles className="h-4 w-4" />}
            title="Weekly Normalization"
          />
          <WeeklyNormalizationTab aiEnabled={aiEnabled} products={references.products} />
        </div>
      )}
    </div>
  );
}
