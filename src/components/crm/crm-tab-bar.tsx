"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Database, Loader2 } from "lucide-react";

// Value import from the dependency-free sibling file, NOT master.ts itself — master.ts pulls in
// the Supabase admin client + employee-directory/PDF chain, which must never reach this "use
// client" component's bundle.
import { CRM_MASTER_DATASETS, type CrmMasterDataset } from "@/lib/crm/master-datasets";

export type CrmActiveTab = CrmMasterDataset | "unmapped" | "recovered" | "region_mapping";

/** Aggregated/derived views that sit alongside the raw per-dataset tabs — not a CrmMasterDataset,
 * since they don't come from a paginated slice of one table (see CrmUnmappedIdentitiesPanel /
 * CrmRecoveredChainsPanel / CrmRegionMappingPanel). */
const EXTRA_TABS: ReadonlyArray<{ id: "unmapped" | "recovered" | "region_mapping"; label: string }> = [
  { id: "unmapped", label: "Unmapped Agents" },
  { id: "region_mapping", label: "Region Mapping" },
  { id: "recovered", label: "Recovered Chains" },
];

/** One tab bar for the whole CRM hub — raw datasets + the two derived views — so switching between
 * "look at the raw mirror" and "resolve an identity" / "review recovered chains" never hides the
 * other destinations. Lives above whichever content the page renders for the active tab. */
export function CrmTabBar({ active }: { active: CrmActiveTab }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [pendingTab, setPendingTab] = useState<CrmActiveTab | null>(null);
  const activeDisplay = isPending && pendingTab ? pendingTab : active;

  function switchTo(tab: CrmActiveTab) {
    if (tab === active) return;
    setPendingTab(tab);
    const params = new URLSearchParams(searchParams.toString());
    // Reset pagination + dataset-specific filters on every tab switch; keep the shared date range,
    // agent HR ID, line, and hiring-date filters (same as the old per-dataset switchDataset).
    for (const key of ["page", "search", "ampm", "visitType", "mappingStatus", "minDuration", "halfDaysOnly"]) {
      params.delete(key);
    }
    if (tab === "unmapped" || tab === "recovered" || tab === "region_mapping") {
      params.delete("dataset");
      params.set("view", tab);
    } else {
      params.delete("view");
      params.set("dataset", tab);
    }
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  return (
    <div className="inline-flex flex-wrap overflow-hidden border border-slate-200">
      {CRM_MASTER_DATASETS.map((ds) => (
        <TabButton
          isActive={activeDisplay === ds.id}
          isLoading={isPending && pendingTab === ds.id}
          key={ds.id}
          label={ds.label}
          onClick={() => switchTo(ds.id)}
        />
      ))}
      {EXTRA_TABS.map((tab) => (
        <TabButton
          isActive={activeDisplay === tab.id}
          isLoading={isPending && pendingTab === tab.id}
          key={tab.id}
          label={tab.label}
          onClick={() => switchTo(tab.id)}
        />
      ))}
    </div>
  );
}

function TabButton({
  isActive,
  isLoading,
  label,
  onClick,
}: {
  isActive: boolean;
  isLoading: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-bold transition ${
        isActive ? "bg-orange-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
      }`}
      onClick={onClick}
      type="button"
    >
      {isLoading ? (
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Database aria-hidden="true" className="h-3.5 w-3.5" />
      )}
      {label}
    </button>
  );
}
