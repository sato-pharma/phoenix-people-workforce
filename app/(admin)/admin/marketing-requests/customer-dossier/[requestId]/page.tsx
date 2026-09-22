import { ValidatedCustomerDetailView } from "@/components/marketing-requests/validated-customer-detail";

import { assertMarketingAdminPageAccess } from "../../admin-access";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

/**
 * The full validation dossier for the customer a marketing request stands on — reached from the
 * "already validated" badge on the approver window (owner ask, 2026-09-22). Keyed by REQUEST id,
 * never customer id: the page shell only lets a marketing-inbox user in (the same guard as the
 * inbox the badge lives on), and the DATA is served by /api/marketing-requests/[id]/customer-dossier,
 * which authorizes against the request itself — so an approver only ever sees the dossier for a
 * request the system already handed them. Nothing customer-identifying renders until that API answers.
 */
export default async function AdminMarketingCustomerDossierPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  await assertMarketingAdminPageAccess({ approvalInbox: true });

  const { requestId } = await params;

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Customer Check</h1>
          <p className={pageHeaderDescriptionClassName}>
            Everything captured for the customer on this request — the location, the photo, the distributor codes and
            what is still missing — so you can confirm it was validated before you decide.
          </p>
        </div>
      </div>
      {/* customerId is unused when an endpoint is supplied: this view fetches the request-keyed
          dossier, and the transfer action (its only other use of customerId) never renders for an
          approver, because the approver dossier is strictly read-only (viewerCanTransfer: false). */}
      <ValidatedCustomerDetailView
        backHref="/admin/marketing-requests/inbox"
        backLabel="Back to the approval inbox"
        customerId=""
        endpoint={`/api/marketing-requests/${requestId}/customer-dossier`}
      />
    </div>
  );
}
