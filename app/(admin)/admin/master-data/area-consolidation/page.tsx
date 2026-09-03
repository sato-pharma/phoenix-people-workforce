import { redirect } from "next/navigation";

import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canRunAreaConsolidation } from "@/lib/territory-management/area-consolidation";
import { AreaConsolidationWorkspace } from "@/components/territory-management/area-consolidation-workspace";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

/**
 * The Super Admin's own hands on the lever.
 *
 * Owner, 2026-08-22: "I want me to be able to, in the system itself, I check if confirmed, I press
 * the button, and it goes. I don't want you to do any of this critical sensitive work."
 */
export default async function AreaConsolidationPage() {
  const access = await resolveAccessContextFromPage();
  if (!canRunAreaConsolidation(access)) redirect("/admin/master-data");

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Master Data</p>
          <h1 className={pageHeaderTitleClassName}>Area Consolidation</h1>
          <p className={pageHeaderDescriptionClassName}>
            Move everything off a legacy area onto the area it actually means — after you have read the list.
          </p>
        </div>
      </div>
      <AreaConsolidationWorkspace />
    </div>
  );
}
