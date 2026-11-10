import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MarketingFunctionsBody } from "@/components/marketing-functions/page-bodies";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Dr. Rasha's Monthly Marketing Functions sheet (owner, 2026-11-10). The gate is INLINE: a nav entry's
 * `permission` mirrors the gate the page enforces, and the guard keeping them honest reads this file.
 * UX only: every /api/marketing-functions route asserts its permission, and the service narrows the
 * rows (a Product Manager opens only his own month).
 */
export default async function EmployeePortalMarketingFunctionsPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/marketing-functions");
  }
  if (!(await canAccess(access, "marketing_functions", "read"))) {
    redirect("/employee-portals");
  }
  const params = await searchParams;

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Your marketing activities and plans for the month, in the eight categories of the sheet: what you planned, what you actually did, and where each item stands."
      title="Monthly Marketing Functions"
    >
      <MarketingFunctionsBody
        access={access}
        basePath="/employee-portals/marketing-functions"
        feedbackBasePath="/employee-portals/marketing-feedback"
        params={params}
      />
    </EmployeePortalPageShell>
  );
}
