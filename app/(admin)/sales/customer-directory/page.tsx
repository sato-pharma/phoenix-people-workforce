import { redirect } from "next/navigation";

import { CustomerDirectoryWorkspace } from "@/components/sales/customer-directory-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  listCustomerDirectory,
  loadCustomerDirectoryFilterOptions,
  type CustomerDirectoryFilterOptions,
  type CustomerDirectoryListResult,
} from "@/lib/sales/customer-directory";

export const dynamic = "force-dynamic";

export default async function CustomerDirectoryPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/sales");
  }
  if (access.role !== "Super Admin" && access.scope !== "system") {
    redirect(resolveLandingPathForRole(access.role));
  }

  let options: CustomerDirectoryFilterOptions = { areas: [], bricks: [], distributors: [], periods: [], regions: [] };
  let initialResult: CustomerDirectoryListResult | null = null;
  let initialError: string | null = null;

  try {
    await assertPermission(access, "sales", "import");
    [options, initialResult] = await Promise.all([
      loadCustomerDirectoryFilterOptions(),
      listCustomerDirectory({}),
    ]);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Customer Directory.";
  }

  return <CustomerDirectoryWorkspace initialError={initialError} initialResult={initialResult} options={options} />;
}
