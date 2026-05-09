import { redirect } from "next/navigation";

import { SalesPerformancePage } from "@/components/sales/sales-performance-page";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getSalesDashboard } from "@/lib/sales/service";

export const dynamic = "force-dynamic";

function normalizeProductsInput(value?: string | string[]) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (typeof entry === "string" ? entry.split(",") : [])).map((entry) => entry.trim()).filter(Boolean);
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export default async function EmployeePortalSalesPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; family?: string; products?: string | string[] }>;
}) {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) !== "employee-portal") {
    redirect("/sales");
  }

  const resolvedParams = await searchParams;

  let initialData = null;

  try {
    await assertPermission(accessContext, "sales", "read");

    // Build filters from search params
    const filters: Record<string, unknown> = {};
    if (resolvedParams.period) filters.period = resolvedParams.period;
    if (resolvedParams.family) filters.family = resolvedParams.family;
    const normalizedProducts = normalizeProductsInput(resolvedParams.products);
    if (normalizedProducts.length > 0) filters.products = normalizedProducts;
    
    initialData = await getSalesDashboard(filters, accessContext);
  } catch {
    initialData = null;
  }

  if (!initialData) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-lg font-semibold text-slate-900">Sales Data Unavailable</p>
        <p className="mt-2 text-sm text-slate-600">Unable to load sales performance data. Please try again later.</p>
      </div>
    );
  }

  return <SalesPerformancePage data={initialData} isLoading={false} />;
}
