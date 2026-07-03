import { redirect } from "next/navigation";

import { CustomerMappingWorkspace } from "@/components/sales/customer-mapping-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  listCustomerMapping,
  loadCustomerMappingFilterOptions,
  type CustomerDirectoryFilterOptions,
  type CustomerMappingResult,
} from "@/lib/sales/customer-mapping";

export const dynamic = "force-dynamic";

export default async function CustomerMappingPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  if (access.role !== "Super Admin" && access.scope !== "system") {
    redirect(resolveLandingPathForRole(access.role));
  }

  let options: CustomerDirectoryFilterOptions = { areas: [], bricks: [], distributors: [], periods: [], regions: [] };
  let initialResult: CustomerMappingResult | null = null;
  let initialError: string | null = null;

  try {
    await assertPermission(access, "sales", "import");
    [options, initialResult] = await Promise.all([
      loadCustomerMappingFilterOptions(),
      listCustomerMapping({}, access.role),
    ]);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Customer Mapping.";
  }

  return <CustomerMappingWorkspace initialError={initialError} initialResult={initialResult} options={options} />;
}
