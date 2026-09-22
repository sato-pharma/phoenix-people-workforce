import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { ValidatedCustomerDetailView } from "@/components/marketing-requests/validated-customer-detail";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

/**
 * The full validation dossier for the customer a marketing request stands on — reached from the
 * "already validated" badge on the portal approver window (owner ask, 2026-09-22). Keyed by REQUEST
 * id: the page shell reuses the marketing-inbox guard (the same gate as the inbox the badge lives
 * on), and the DATA is served by /api/marketing-requests/[id]/customer-dossier, which authorizes
 * against the request itself — so an approver only ever opens the dossier for a request handed to
 * them, and cannot enumerate the customer register.
 */
export default async function EmployeePortalMarketingCustomerDossierPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  await assertEmployeePortalMarketingPageAccess("inbox");

  const { requestId } = await params;

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Everything captured for the customer on this request — the location, the photo, the distributor codes and what is still missing — so you can confirm it was validated before you decide."
      title="Customer Check"
    >
      {/* customerId is unused when an endpoint is supplied: this view fetches the request-keyed
          dossier, and the transfer action (its only other use of customerId) never renders for an
          approver — the approver dossier is strictly read-only (viewerCanTransfer: false). */}
      <ValidatedCustomerDetailView
        backHref="/employee-portals/marketing-requests/inbox"
        backLabel="Back to the approval inbox"
        customerId=""
        endpoint={`/api/marketing-requests/${requestId}/customer-dossier`}
      />
    </EmployeePortalPageShell>
  );
}
