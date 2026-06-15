import { redirect } from "next/navigation";

import { WeeklyMissingProducts } from "@/components/sales/weekly/weekly-missing-products";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadWeeklyMissingProducts } from "@/lib/sales/weekly/service";
import type { WeeklyMissingProduct } from "@/lib/sales/weekly/types";

export const dynamic = "force-dynamic";

export default async function WeeklyMissingProductsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  if (!(await canAccess(access, "weekly_sales", "update"))) redirect("/sales/weekly/dashboard");

  let initial: WeeklyMissingProduct[] = [];
  let initialError: string | null = null;
  try {
    initial = await loadWeeklyMissingProducts();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load missing products.";
  }

  return <WeeklyMissingProducts initial={initial} initialError={initialError} />;
}
