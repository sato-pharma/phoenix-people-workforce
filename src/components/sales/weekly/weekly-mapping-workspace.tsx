"use client";

import { MapPin, Tags, Tag } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { WeeklyBranchRegionAdmin } from "@/lib/sales/weekly/branch-region-map";
import type { WeeklyProductAliasAdmin } from "@/lib/sales/weekly/product-aliases";
import { cn } from "@/lib/utils";

import { WeeklyBranchMappingManager } from "./weekly-branch-mapping-manager";
import { WeeklyProductMappingManager } from "./weekly-product-mapping-manager";

export type WeeklyMappingTab = "branch" | "products";

type Props = {
  initialTab?: WeeklyMappingTab;
  /** Pre-select a distributor on the Products tab (carried from an "Add Alias" deep-link). */
  initialProductsDistributor?: string;
  branch: { initial: WeeklyBranchRegionAdmin | null; initialError: string | null };
  products: { initial: WeeklyProductAliasAdmin | null; initialError: string | null };
};

const TABS: { key: WeeklyMappingTab; label: string; icon: typeof MapPin }[] = [
  { key: "branch", label: "Branch → Region", icon: MapPin },
  { key: "products", label: "Products", icon: Tags },
];

/**
 * Single canonical surface for every Weekly Sales mapping task. Replaces the old standalone routes
 * (branch-mapping, product-mapping, mapping) with one tabbed page, mirroring the Source-of-Sales
 * import workspace pattern. Each tab renders its existing manager unchanged.
 *
 * A third "Missing Products" tab lived here until 2026-08-21. It listed stored rows with
 * validation_state='warning' — a state weekly validation never produces, because any failure blocks
 * the whole batch and nothing persists. So it was a guaranteed-empty full scan of weekly_sales_rows
 * on every page load, under a heading that told the operator every item resolves. Unmapped labels
 * surface in the Normalizer preview instead, before the batch is ever stored.
 */
export function WeeklyMappingWorkspace({ initialTab, initialProductsDistributor, branch, products }: Props) {
  const [activeTab, setActiveTab] = useState<WeeklyMappingTab>(initialTab ?? "branch");
  // Carried from an "Add Alias" deep-link. Fixed for the life of the page now that the Missing
  // Products tab (the only thing that used to switch it in place) is gone.
  const productsDistributor = initialProductsDistributor;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header className="rounded-[6px] border border-[#E2E8F0] bg-white px-4 py-3 shadow-sm">
        <div className="mb-1 flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">
          <span className="h-2 w-2 rounded-full bg-[#F97316]" />
          Weekly Sales
        </div>
        <h1 className="flex items-center gap-2 text-xl font-black text-[#0F172A]">
          <Tag className="h-5 w-5 text-[#F97316]" /> Weekly Mapping
        </h1>
        <p className="mt-1 text-sm font-medium text-[#64748B]">
          Everything that teaches the weekly importer how each distributor&apos;s raw file maps to official
          Phoenix codes — branch→region and product aliases — in one place.
        </p>
      </header>

      <div className="flex flex-wrap gap-2 rounded-[6px] border border-[#E2E8F0] bg-white p-2 shadow-sm">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;
          return (
            <Button
              key={tab.key}
              className={cn("gap-2 rounded-[6px] font-black", active ? "bg-[#0B0B0B] text-white hover:bg-[#F97316]" : "")}
              onClick={() => setActiveTab(tab.key)}
              type="button"
              variant="secondary"
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </Button>
          );
        })}
      </div>

      <div className="rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
        {activeTab === "branch" ? (
          <WeeklyBranchMappingManager initial={branch.initial} initialError={branch.initialError} />
        ) : (
          <WeeklyProductMappingManager
            key={productsDistributor ?? "default"}
            initial={products.initial}
            initialError={products.initialError}
            initialDistributor={productsDistributor}
          />
        )}
      </div>
    </div>
  );
}
