import { redirect } from "next/navigation";

import { WeeklyMappingWorkspace, type WeeklyMappingTab } from "@/components/sales/weekly/weekly-mapping-workspace";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadWeeklyBranchRegionAdmin } from "@/lib/sales/weekly/branch-region-map";
import { loadMappingAdmin } from "@/lib/sales/weekly/mapping";
import { loadMissingAdmin } from "@/lib/sales/weekly/missing";
import { loadWeeklyProductAliasAdmin } from "@/lib/sales/weekly/product-aliases";
import { loadWeeklyMissingProducts } from "@/lib/sales/weekly/service";

export const dynamic = "force-dynamic";
// The missing-products scan pages stored weekly rows — give it more than the default budget.
export const maxDuration = 60;

const TAB_KEYS: WeeklyMappingTab[] = ["branch", "products", "missing-products", "missing-labels", "mapping-workbook"];

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

  const [branch, products, missingProducts, missingLabels, mappingWorkbook] = await Promise.all([
    safeLoad(() => loadWeeklyBranchRegionAdmin("IS", "any")),
    safeLoad(() => loadWeeklyProductAliasAdmin("IS")),
    safeLoad(() => loadWeeklyMissingProducts()),
    safeLoad(() => loadMissingAdmin()),
    safeLoad(() => loadMappingAdmin()),
  ]);

  return (
    <WeeklyMappingWorkspace
      initialTab={initialTab}
      initialProductsDistributor={initialProductsDistributor}
      branch={{ initial: branch.data, initialError: branch.error }}
      products={{ initial: products.data, initialError: products.error }}
      missingProducts={{ initial: missingProducts.data ?? [], initialError: missingProducts.error }}
      missingLabels={{ data: missingLabels.data, error: missingLabels.error }}
      mappingWorkbook={{ data: mappingWorkbook.data, error: mappingWorkbook.error }}
    />
  );
}
