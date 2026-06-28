import { MarketingBulkUploadPanel } from "@/components/marketing-requests/bulk-upload-panel";

import { assertMarketingAdminPageAccess } from "../admin-access";

export const dynamic = "force-dynamic";

export default async function AdminMarketingBulkUploadPage() {
  await assertMarketingAdminPageAccess({ systemAdministratorOnly: true });

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Marketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Bulk Upload — Historical Requests</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Download the XLSX template, fill it with historical marketing request data, then upload
          the completed file. Each row is validated and inserted exactly as if submitted through
          the system — same request codes, products, pharmacies, and approval records.
        </p>
      </div>
      <MarketingBulkUploadPanel />
    </div>
  );
}
