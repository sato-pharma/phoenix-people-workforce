import { redirect } from "next/navigation";

import { WeeklyMappingWorkspace, type WeeklyMappingTab } from "@/components/sales/weekly/weekly-mapping-workspace";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadWeeklyBranchRegionAdmin } from "@/lib/sales/weekly/branch-region-map";
import { loadWeeklyProductAliasAdmin } from "@/lib/sales/weekly/product-aliases";

export const dynamic = "force-dynamic";

const TAB_KEYS: WeeklyMappingTab[] = ["branch", "products"];

// Each tab loads independently so one failing data source degrades only its own tab, not the page.
async function safeLoad<T>(fn: () => Promise<T>): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await fn(), error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : "Failed to load." };
  }
}

export default async function WeeklyMappingPage({ searchParams }: { searchParams: Promise<{ tab?: string; distributor?: string }> }) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  // Managing weekly mappings is an SFE/admin task — gated on weekly_sales:update (the correct,
  // consistent pattern; replaces the dead `if (!access)` guards of the old mapping/missing pages).
  if (!(await canAccess(access, "weekly_sales", "update"))) redirect("/sales/weekly/dashboard");

  const sp = await searchParams;
  const initialTab = TAB_KEYS.includes(sp?.tab as WeeklyMappingTab) ? (sp?.tab as WeeklyMappingTab) : undefined;
  const initialProductsDistributor = sp?.distributor?.trim() || undefined;

  const [branch, products] = await Promise.all([
    safeLoad(() => loadWeeklyBranchRegionAdmin("IS", "any")),
    safeLoad(() => loadWeeklyProductAliasAdmin("IS")),
  ]);

  return (
    <WeeklyMappingWorkspace
      initialTab={initialTab}
      initialProductsDistributor={initialProductsDistributor}
      branch={{ initial: branch.data, initialError: branch.error }}
      products={{ initial: products.data, initialError: products.error }}
    />
  );
}
