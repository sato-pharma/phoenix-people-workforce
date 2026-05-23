import { SalesPerformancePage } from "@/components/sales/sales-performance-page";
import { redirect } from "next/navigation";
import {
  EmployeePortalActionLink,
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { reportEmployeePortalFailure } from "@/lib/employee-portal/failure-reporting";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getSalesDashboard } from "@/lib/sales/service";

export const dynamic = "force-dynamic";

function normalizeMultiValueInput(value?: string | string[]) {
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
  searchParams: Promise<{ period?: string | string[]; family?: string; products?: string | string[] }>;
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
  if (accessContext.role === "Training Manager") {
    redirect("/employee-portals/training-manager");
  }

  const resolvedParams = await searchParams;

  let initialData = null;
  let supportReference: string | null = null;

  try {
    await assertPermission(accessContext, "sales", "read");

    // Build filters from search params
    const filters: Record<string, unknown> = {};
    const normalizedPeriods = normalizeMultiValueInput(resolvedParams.period);
    if (normalizedPeriods.length > 0) filters.periods = normalizedPeriods;
    if (resolvedParams.family) filters.family = resolvedParams.family;
    const normalizedProducts = normalizeMultiValueInput(resolvedParams.products);
    if (normalizedProducts.length > 0) filters.products = normalizedProducts;
    
    initialData = await getSalesDashboard(filters, accessContext);
  } catch (error) {
    supportReference = await reportEmployeePortalFailure("sales-dashboard", error);
    initialData = null;
  }

  if (!initialData) {
    return (
      <EmployeePortalEmptyState
        message="Unable to load sales performance data right now. Refresh the page, then contact support if it keeps failing."
        supportReference={supportReference}
        title="Sales Data Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      description="Deep performance view with team filters, product mix, and trend diagnostics."
      title="Sales Performance"
    >
      <SalesPerformancePage data={initialData} isLoading={false} />
    </EmployeePortalPageShell>
  );
}
