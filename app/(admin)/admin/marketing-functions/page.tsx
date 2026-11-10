import { redirect } from "next/navigation";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { MarketingFunctionsBody } from "@/components/marketing-functions/page-bodies";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** The admin-shell twin of the Monthly Marketing Functions sheet, for the CEO and the Super Admin. */
export default async function AdminMarketingFunctionsPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/marketing-functions");
  }
  if (!(await canAccess(access, "marketing_functions", "read"))) {
    redirect("/overview");
  }
  const params = await searchParams;

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Monthly Marketing Functions</h1>
          <p className={pageHeaderDescriptionClassName}>
            Each Product Manager’s month in the eight categories of Dr. Rasha’s sheet: planned, actual, and where each item stands.
          </p>
        </div>
      </div>

      <MarketingFunctionsBody
        access={access}
        basePath="/admin/marketing-functions"
        feedbackBasePath="/admin/marketing-feedback"
        params={params}
      />
    </div>
  );
}
