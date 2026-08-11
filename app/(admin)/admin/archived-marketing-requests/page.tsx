import { redirect } from "next/navigation";

import { MarketingRoiTracker } from "@/components/marketing-requests/marketing-roi-tracker";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

import { assertMarketingAdminPageAccess } from "../marketing-requests/admin-access";

export const dynamic = "force-dynamic";

/**
 * Archived Marketing Requests — the historical set imported from the Excel sheet.
 *
 * A SEPARATE module from the live one, by owner decision (2026-07-28): from 2026-08-01 every
 * marketing request is submitted in Phoenix, and Phoenix data is materially more accurate because
 * it is validated at entry (the Customer Validation UI runs the pharmacy code-reference check the
 * bulk importer never ran). Reporting the two together would drag genuine Phoenix performance down
 * with legacy data quality, so they are kept apart at the data layer via marketing_requests.origin.
 *
 * "Archived" here means PROVENANCE ("came from Excel"), not the status='archived' lifecycle state.
 */
export default async function ArchivedMarketingRequestsPage() {
  // Owner, 2026-08-11: revoked for the Finance Manager at the PAGE, not just the sidebar. These
  // three had been hidden from his navigation only, which a live role sweep showed still rendered
  // them on a typed or bookmarked URL — hidden is not revoked. He keeps Monthly Closing and the
  // Marketing Inbox; what goes is sales-management reporting and the legacy Excel ROI set.
  // allowCompanyOversight admits him by company scope, so the role clause has to come first.
  const archivedAccess = await resolveAccessContextFromPage();
  if (archivedAccess.role === "Finance Manager") redirect("/admin/marketing-requests/inbox");
  await assertMarketingAdminPageAccess({ allowCompanyOversight: true });

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <MarketingRoiTracker origin="xlsx_import" />
    </div>
  );
}
