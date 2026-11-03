import { redirect } from "next/navigation";

import { DirectOrderRequestDetail } from "@/components/approvals-hub/direct-order-request-detail";
import { PharmacyValidationCapture } from "@/components/direct-orders/pharmacy-validation-capture";
import { CancelHeldOrder } from "@/components/direct-orders/cancel-held-order";
import { getDirectOrderApprovalDetail } from "@/lib/direct-orders/service";
import { canCancelHeldDirectOrder } from "@/lib/direct-orders/cancel-visibility";
import { canCaptureDirectOrderValidation } from "@/lib/direct-orders/validation-visibility";
import { getDirectOrderInvoiceValidationSlots } from "@/lib/direct-orders/pharmacy-validation";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { directOrderCustomer360Href } from "@/lib/customer-360/hrefs";
import { canOpenCustomer360 } from "@/lib/customer-360/open-link";
import { assertDirectOrdersPageAccess } from "@/lib/direct-orders/page-access";
import { resolveDirectOrderReturnHref } from "@/lib/direct-orders/workspace-data";

export const dynamic = "force-dynamic";

/**
 * A REQUESTER tracking their own direct order.
 *
 * Deliberately the SAME component and the SAME payload the approver sees — the owner's
 * requirement is that a requester can follow their request in the same detail, not a reduced
 * summary. The only differences are framing: this route is reached from "My direct orders"
 * rather than an approvals queue, and the back link returns there.
 *
 * No extra permission gate is needed or wanted. `getDirectOrderApprovalDetail` already answers
 * null for a request outside the caller's scope, and its scope rule admits the requester for
 * their OWN request — so this page shows a requester their order and nobody else's. The decision
 * buttons suppress themselves: availableActions are all false for a non-approver, and both
 * decision panels render null when no action is available.
 */
export default async function AdminMyDirectOrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  await assertDirectOrdersPageAccess(access);
  const { id } = await params;
  const { from } = await searchParams;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(
      `/employee-portals/direct-orders/${encodeURIComponent(id)}` +
        // Carried across the hop. The redirect is meant to be invisible; dropping the return
        // context here would make it visible in the worst way — by losing their place.
        (from ? `?from=${encodeURIComponent(from)}` : ""),
    );
  }
  const detail = await getDirectOrderApprovalDetail(access, id);

  // The validation door, shown exactly where the rep meets the problem (spec A2). The rule lives in
  // canCaptureDirectOrderValidation so this page and its portal twin cannot disagree — they already
  // did once, and the portal (the only route a rep can reach) was the one left without a door.
  const showValidation = canCaptureDirectOrderValidation(access.hrId, detail);
  // The rep's own invoice slots, read only when the capture is offered — it is the counter beside
  // the distributor-invoice route (owner, 2026-09-14).
  const invoiceSlots = showValidation && detail?.pharmacy ? await getDirectOrderInvoiceValidationSlots(access) : null;

  // The other door out of the held lane (audit F3): withdrawing an order that should not have been
  // raised. Same shared predicate as the portal twin, for the same reason as the capture above.
  const showCancel = canCancelHeldDirectOrder({ hrId: access.hrId, role: access.role }, detail);

  const canOpenCustomer = detail?.pharmacy ? await canOpenCustomer360(access) : false;
  const customer360Href = canOpenCustomer && detail?.pharmacy ? directOrderCustomer360Href(detail.pharmacy.id) : null;

  return (
    <div className="space-y-5">
      {/* Back to the LIST THEY CAME FROM — tab, filter, search and page intact. An approver works
          down a queue one order at a time, and returning them to an unfiltered Overview made them
          rebuild it every single time. resolveDirectOrderReturnHref refuses anything that is not
          this exact workspace path, so the query string cannot become an open redirect. */}
      <DirectOrderRequestDetail
        detail={detail}
        backHref={resolveDirectOrderReturnHref(from, "/admin/direct-orders")}
        backLabel="Back to My Direct Orders"
        customer360Href={customer360Href}
      />
      {showValidation && detail?.pharmacy ? (
        <PharmacyValidationCapture
          pharmacyId={detail.pharmacy.id}
          pharmacyName={detail.pharmacy.pharmacyName}
          requestId={detail.request.id}
          distributorCodeCount={detail.pharmacy.distributorCodes.length}
          venueType={detail.pharmacy.venueType}
          invoiceSlots={invoiceSlots ? { used: invoiceSlots.used, limit: invoiceSlots.limit } : null}
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
  );
}
