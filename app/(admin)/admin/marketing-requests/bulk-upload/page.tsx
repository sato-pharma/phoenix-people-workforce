import { MarketingBulkUploadPanel } from "@/components/marketing-requests/bulk-upload-panel";

import { assertMarketingAdminPageAccess } from "../admin-access";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

export default async function AdminMarketingBulkUploadPage() {
  await assertMarketingAdminPageAccess({ systemAdministratorOnly: true });

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Bulk Upload — Historical Requests</h1>
          <p className={pageHeaderDescriptionClassName}>
            Download the XLSX template, fill it with historical marketing request data, then upload
            the completed file. Each row is validated and inserted exactly as if submitted through
            the system — same request codes, products, pharmacies, and approval records.
          </p>
        </div>
      </div>
      <MarketingBulkUploadPanel />
    </div>
  );
}
