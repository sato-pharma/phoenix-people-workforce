import { MarketingRoiTracker } from "@/components/marketing-requests/marketing-roi-tracker";

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
  await assertMarketingAdminPageAccess({ allowCompanyOversight: true });

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="rounded-sm border border-slate-200 bg-slate-50 p-4">
        <p className="text-sm font-semibold text-slate-900">Historical records — imported from Excel</p>
        <p className="mt-1 text-sm text-slate-600">
          These requests were migrated from the historical marketing sheet before Phoenix became the
          system of record on 1 August 2026. They are kept separate because they were never validated
          at entry: their pharmacy codes were not checked against the reference database and they
          carry no live approval chain. Read them as history, not as live performance — the live
          numbers are in ROI Tracker.
        </p>
      </div>
      <MarketingRoiTracker basePath="/admin" origin="xlsx_import" />
    </div>
  );
}
