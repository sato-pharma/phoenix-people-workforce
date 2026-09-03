import { redirect } from "next/navigation";

import { PharmacyMasterWorkspace } from "@/components/pharmacy-master/pharmacy-master-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessPharmacyMaster } from "@/lib/pharmacy-master/pharmacy-matching";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

// Standalone, read-only Phase 1 candidate-review report — detects pharmacies that may be the
// same physical location recorded separately under different distributors. Suggestion-only:
// no merge, no auto-create, no approve/reject action anywhere on this page.
export default async function PharmacyMasterPage() {
  const access = await resolveAccessContextFromPage();
  if (!canAccessPharmacyMaster(access)) {
    redirect("/");
  }

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Master Data</p>
          <h1 className={pageHeaderTitleClassName}>Pharmacy Master</h1>
          <p className={pageHeaderDescriptionClassName}>
            Read-only candidate review: pharmacies that may be the same physical location, recorded
            separately under different distributors. Nothing here merges, creates, or changes any
            record — every candidate needs human review before any action is taken.
          </p>
        </div>
      </div>
      <PharmacyMasterWorkspace />
    </div>
  );
}
