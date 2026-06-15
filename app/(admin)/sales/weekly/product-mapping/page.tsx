import { redirect } from "next/navigation";

import { WeeklyProductMappingManager } from "@/components/sales/weekly/weekly-product-mapping-manager";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadWeeklyProductAliasAdmin, type WeeklyProductAliasAdmin } from "@/lib/sales/weekly/product-aliases";

export const dynamic = "force-dynamic";

export default async function WeeklyProductMappingPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  // Managing product aliases is an SFE/admin task — gated on weekly_sales:update.
  if (!(await canAccess(access, "weekly_sales", "update"))) redirect("/sales/weekly/dashboard");

  let initial: WeeklyProductAliasAdmin | null = null;
  let initialError: string | null = null;
  try {
    initial = await loadWeeklyProductAliasAdmin("IS");
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load product mapping.";
  }

  return <WeeklyProductMappingManager initial={initial} initialError={initialError} />;
}
