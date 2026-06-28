import { redirect } from "next/navigation";

import { SalesPerformancePage } from "@/components/sales/sales-performance-page";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { getSalesDashboard } from "@/lib/sales/service";

export const dynamic = "force-dynamic";

export default async function EmployeePortalSalesPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string | string[]; family?: string; products?: string | string[] }>;
}) {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) !== "employee-portal") {
    redirect("/sales");
  }
  if (accessContext.role === "Training Manager") {
    redirect("/employee-portals/training-manager");
  }

  await assertPermission(accessContext, "sales", "read");

  const resolvedParams = await searchParams;

  function normalizeMultiValueInput(value?: string | string[]) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.flatMap((entry) => (typeof entry === "string" ? entry.split(",") : [])).map((entry) => entry.trim()).filter(Boolean);
    }
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }

  let initialData = null;
  try {
    const filters: Record<string, unknown> = {};
    const normalizedPeriods = normalizeMultiValueInput(resolvedParams.period);
    if (normalizedPeriods.length > 0) filters.periods = normalizedPeriods;
    if (resolvedParams.family) filters.family = resolvedParams.family;
    const normalizedProducts = normalizeMultiValueInput(resolvedParams.products);
    if (normalizedProducts.length > 0) filters.products = normalizedProducts;
    initialData = await getSalesDashboard(filters, accessContext);
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/sales", module: "sales", role: accessContext.role, hrId: accessContext.hrId },
      error,
    );
    initialData = null;
  }

  if (!initialData) {
    return (
      <EmployeePortalEmptyState
        message="Unable to load sales data. Please try again later."
        title="Sales Data Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      description="Deep performance view with team filters, product mix, and trend diagnostics."
      title="Source of Sales"
    >
      <SalesPerformancePage data={initialData} isLoading={false} />
    </EmployeePortalPageShell>
  );
}
