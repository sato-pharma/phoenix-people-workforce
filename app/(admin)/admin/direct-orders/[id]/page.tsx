import { redirect } from "next/navigation";

import { DirectOrderRequestDetail } from "@/components/approvals-hub/direct-order-request-detail";
import { PharmacyValidationCapture } from "@/components/direct-orders/pharmacy-validation-capture";
import { getDirectOrderApprovalDetail } from "@/lib/direct-orders/service";
import { canCaptureDirectOrderValidation } from "@/lib/direct-orders/validation-visibility";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

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
export default async function AdminMyDirectOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/direct-orders/${encodeURIComponent(id)}`);
  }
  const detail = await getDirectOrderApprovalDetail(access, id);

  // The validation door, shown exactly where the rep meets the problem (spec A2). The rule lives in
  // canCaptureDirectOrderValidation so this page and its portal twin cannot disagree — they already
  // did once, and the portal (the only route a rep can reach) was the one left without a door.
  const showValidation = canCaptureDirectOrderValidation(access.hrId, detail);

  return (
    <div className="space-y-5">
      <DirectOrderRequestDetail detail={detail} backHref="/admin/direct-orders" backLabel="Back to My Direct Orders" />
      {showValidation && detail?.pharmacy ? (
        <PharmacyValidationCapture
          pharmacyId={detail.pharmacy.id}
          pharmacyName={detail.pharmacy.pharmacyName}
          requestId={detail.request.id}
        />
      ) : null}
    </div>
  );
}
