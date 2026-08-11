import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DirectOrderRequestDetail } from "@/components/approvals-hub/direct-order-request-detail";
import { PharmacyValidationCapture } from "@/components/direct-orders/pharmacy-validation-capture";
import { CancelHeldOrder } from "@/components/direct-orders/cancel-held-order";
import { getDirectOrderApprovalDetail } from "@/lib/direct-orders/service";
import { canCancelHeldDirectOrder } from "@/lib/direct-orders/cancel-visibility";
import { canCaptureDirectOrderValidation } from "@/lib/direct-orders/validation-visibility";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertDirectOrdersPageAccess } from "@/lib/direct-orders/page-access";

export const dynamic = "force-dynamic";

/**
 * Portal mirror of the requester's tracking view — see the admin route for why there is no extra
 * permission gate. Same component, same payload, same detail the approver sees; only the framing
 * and the back link differ.
 */
export default async function PortalMyDirectOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  await assertDirectOrdersPageAccess(access);
  const { id } = await params;
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`/admin/direct-orders/${encodeURIComponent(id)}`);
  }
  const detail = await getDirectOrderApprovalDetail(access, id);

  // The validation door (spec A2). THIS is the route a rep actually reaches — the admin twin above
  // redirects them here — so the capture living only on that twin meant no rep could ever open it.
  // Same predicate on both pages so they cannot diverge again.
  const showValidation = canCaptureDirectOrderValidation(access.hrId, detail);

  // The way OUT of the held lane for an order that should never have been raised (audit F3). Mounted
  // on this page as well as the admin twin for exactly the reason the capture had to be: a rep only
  // ever reaches the portal, so a control that lives only on the admin page cannot be used by the
  // person it was built for.
  const showCancel = canCancelHeldDirectOrder({ hrId: access.hrId, role: access.role }, detail);

  return (
    <EmployeePortalPageShell
      badge="Direct Orders"
      title="My Direct Order"
      description="Track this request: every detail your approvers see, and exactly which rung it is waiting on."
    >
      <div className="space-y-5">
        {/* The SHARED order detail, not a portal copy. `direct-order-portal-detail.tsx` was an
            860-line twin of this 1,005-line component taking the identical
            `DirectOrderApprovalDetail` payload — and the mobile approval-window hardening
            (tests/direct-orders-approval-window-mobile.test.ts) was done on THIS one, so the
            portal was the copy running the older layout. */}
        <DirectOrderRequestDetail
          detail={detail}
          backHref="/employee-portals/direct-orders"
          backLabel="Back to Direct Orders"
        />
        {showValidation && detail?.pharmacy ? (
          <PharmacyValidationCapture
            pharmacyId={detail.pharmacy.id}
            pharmacyName={detail.pharmacy.pharmacyName}
            requestId={detail.request.id}
          />
        ) : null}
        {showCancel && detail ? (
          <CancelHeldOrder
            requestId={detail.request.id}
            productName={detail.request.productName}
            qty={detail.request.qty}
            salesValue={detail.request.salesValue}
          />
        ) : null}
      </div>
    </EmployeePortalPageShell>
  );
}
