"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Database, Loader2 } from "lucide-react";

// Value import from the dependency-free sibling file, NOT master.ts itself — master.ts pulls in
// the Supabase admin client + employee-directory/PDF chain, which must never reach this "use
// client" component's bundle.
import { CRM_MASTER_DATASETS, type CrmMasterDataset } from "@/lib/crm/master-datasets";

export type CrmActiveTab = CrmMasterDataset | "unmapped" | "recovered" | "region_mapping" | "customer_mapping" | "account_setup";

export type CrmExtraTab = { id: "unmapped" | "recovered" | "region_mapping" | "customer_mapping" | "account_setup"; label: string };

/** Aggregated/derived views that sit alongside the raw per-dataset tabs — not a CrmMasterDataset,
 * since they don't come from a paginated slice of one table (see CrmUnmappedIdentitiesPanel /
 * CrmRecoveredChainsPanel / CrmRegionMappingPanel / CrmCustomerMappingPanel). These four are
 * UNSCOPED Super-Admin governance panels, so the portal CRM passes extraTabs={[]} to omit them. */
const DEFAULT_EXTRA_TABS: ReadonlyArray<CrmExtraTab> = [
  // First, deliberately, and the position is doing real work. It is the only tab here with a
  // per-person deadline behind it — a new rep whose CRM account is not created keeps working, and
  // every day of it lands under an unmapped agent id, which is what the tab beside it then has to
  // clean up. It is also the only route to the queue other than the "an employee was added" notice
  // itself: a card on the /admin/crm-tools hub was written and then withdrawn, because hub cards are
  // PROMOTED INTO RAIL ROWS and that would add a sidebar row, against the owner's 2026-09-05
  // navigation ruling that collapsed CRM to one hub button. A tab is the right shape anyway — this
  // is a view of the CRM workspace, not a module of its own.
  { id: "account_setup", label: "New Hire CRM Setup" },
  { id: "unmapped", label: "Unmapped Agents" },
  { id: "region_mapping", label: "Region Mapping" },
  { id: "customer_mapping", label: "Customer Mapping" },
  { id: "recovered", label: "Recovered Chains" },
];

/** One tab bar for the whole CRM hub — raw datasets + the two derived views — so switching between
 * "look at the raw mirror" and "resolve an identity" / "review recovered chains" never hides the
 * other destinations. Lives above whichever content the page renders for the active tab. */
export function CrmTabBar({
  active,
  extraTabs = DEFAULT_EXTRA_TABS,
  surface = "admin",
}: {
  active: CrmActiveTab;
  extraTabs?: ReadonlyArray<CrmExtraTab>;
  /**
   * `portal` (the employee-portal CRM only) lays the tabs on an even GRID — two across on a phone,
   * four from `sm` — with no icon on each. Eight bordered buttons that all carried the same database
   * icon wrapped into four to six ragged rows on a phone. `admin` (the default) is unchanged.
   */
  surface?: "admin" | "portal";
}) {
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
    if (tab === "unmapped" || tab === "recovered" || tab === "region_mapping" || tab === "customer_mapping" || tab === "account_setup") {
      params.delete("dataset");
      // The deep link from the "an employee was added" notice carries the person it is about.
      // Leaving it on while switching AWAY would spotlight somebody on an unrelated tab.
      if (tab !== "account_setup") params.delete("hrId");
      params.set("view", tab);
    } else {
      params.delete("view");
      params.set("dataset", tab);
    }
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  if (surface === "portal") {
    return (
      <div className="grid grid-cols-2 border-l border-t border-slate-200 bg-white sm:grid-cols-4">
        {[...CRM_MASTER_DATASETS, ...extraTabs].map((tab) => {
          const isActive = activeDisplay === tab.id;
          const isLoading = isPending && pendingTab === tab.id;
          return (
            <button
              aria-pressed={isActive}
              className={`flex min-h-10 min-w-0 items-center justify-center gap-1.5 border-b border-r border-slate-200 px-2 py-2 text-center text-xs font-bold transition ${
                isActive ? "bg-orange-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
              key={tab.id}
              onClick={() => switchTo(tab.id)}
              type="button"
            >
              {isLoading ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" /> : null}
              <span className="min-w-0 break-words">{tab.label}</span>
            </button>
          );
        })}
      </div>
    );
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
      {extraTabs.map((tab) => (
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
