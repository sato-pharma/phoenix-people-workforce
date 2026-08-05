import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DirectOrderPortalDetail } from "@/components/employee-portal/direct-order-portal-detail";
import { PharmacyValidationCapture } from "@/components/direct-orders/pharmacy-validation-capture";
import { getDirectOrderApprovalDetail } from "@/lib/direct-orders/service";
import { canCaptureDirectOrderValidation } from "@/lib/direct-orders/validation-visibility";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

/**
 * Portal mirror of the requester's tracking view — see the admin route for why there is no extra
 * permission gate. Same component, same payload, same detail the approver sees; only the framing
 * and the back link differ.
 */
export default async function PortalMyDirectOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`/admin/direct-orders/${encodeURIComponent(id)}`);
  }
  const detail = await getDirectOrderApprovalDetail(access, id);

  // The validation door (spec A2). THIS is the route a rep actually reaches — the admin twin above
  // redirects them here — so the capture living only on that twin meant no rep could ever open it.
  // Same predicate on both pages so they cannot diverge again.
  const showValidation = canCaptureDirectOrderValidation(access.hrId, detail);

  return (
    <EmployeePortalPageShell
      badge="Direct Orders"
      title="My Direct Order"
      description="Track this request: every detail your approvers see, and exactly which rung it is waiting on."
    >
      <div className="space-y-5">
        <DirectOrderPortalDetail
          detail={detail}
          backHref="/employee-portals/direct-orders"
          backLabel="Back to My Direct Orders"
        />
        {showValidation && detail?.pharmacy ? (
          <PharmacyValidationCapture
            pharmacyId={detail.pharmacy.id}
            pharmacyName={detail.pharmacy.pharmacyName}
            requestId={detail.request.id}
          />
        ) : null}
      </div>
    </EmployeePortalPageShell>
  );
}
