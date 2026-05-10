import { SalesPerformancePage } from "@/components/sales/sales-performance-page";
import {
  EmployeePortalActionBar,
  EmployeePortalActionLink,
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
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

function buildFiltersLabel(filters: {
  period?: string;
  family?: string;
  products: string[];
}) {
  const parts: string[] = [];
  if (filters.period) parts.push(`Period ${filters.period}`);
  if (filters.family) parts.push(`Family ${filters.family}`);
  if (filters.products.length > 0) parts.push(`Products ${filters.products.length}`);
  return parts.length > 0 ? parts.join(" / ") : "No filters";
}

export default async function EmployeePortalSalesPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; family?: string; products?: string | string[] }>;
}) {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) !== "employee-portal") {
    return (
      <EmployeePortalEmptyState
        message="Sign in with a portal role (Medical Rep, Employee, District Manager, etc.) to view this view."
        title="This page is only available in employee portal mode."
      >
        <div className="mt-4">
          <EmployeePortalActionLink href="/sales" label="Go to Sales Queue" />
        </div>
      </EmployeePortalEmptyState>
    );
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
      <EmployeePortalEmptyState
        message="Unable to load sales performance data. Please try again later."
        title="Sales Data Unavailable"
      />
    );
  }

  const normalizedProducts = normalizeProductsInput(resolvedParams.products);
  const filtersLabel = buildFiltersLabel({
    family: resolvedParams.family,
    period: resolvedParams.period,
    products: normalizedProducts,
  });

  return (
    <EmployeePortalPageShell
      description="Deep performance view with team filters, product mix, and trend diagnostics."
      title="Sales Performance"
    >
      <EmployeePortalActionBar
        actions={
          <>
            <span className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-black text-orange-700 shadow-[0_10px_24px_rgba(249,115,22,0.08)]">
              {filtersLabel}
            </span>
            <EmployeePortalActionLink href="/employee-portals" label="Back to Command Center" />
            <EmployeePortalActionLink href="/employee-portals/payroll" label="Open Payroll" />
          </>
        }
      />
      <SalesPerformancePage data={initialData} isLoading={false} />
    </EmployeePortalPageShell>
  );
}
