import { redirect } from "next/navigation";
import { Unlink } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { ApprovalExceptionsDesk } from "@/components/direct-orders/approval-exceptions-desk";
import { listDirectOrderApprovalExceptions } from "@/lib/direct-orders/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertDirectOrdersPageAccess } from "@/lib/direct-orders/page-access";

export const dynamic = "force-dynamic";

/**
 * Orders waiting on somebody who is not in the employee directory.
 *
 * These do not appear in ANY approver's Needs Action, because the rung is addressed to an HR_ID no
 * session can ever match — that is precisely why they need a desk of their own. Left alone they sit
 * at `pending_approval` until a requester complains.
 *
 * System Admin only, matching `listDirectOrderApprovalExceptions` and the registry row for
 * `repair_approval_rung`. The service enforces the gate; the redirect below is only UX.
 */
export default async function DirectOrdersApprovalExceptionsPage() {
  const access = await resolveAccessContextFromPage();
  await assertDirectOrdersPageAccess(access);
  if (!(access.scope === "system" || access.role === "Super Admin")) redirect("/admin/direct-orders");
  const rows = await listDirectOrderApprovalExceptions(access);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Sales"
        title="Direct Orders — Approval Exceptions"
        description="Orders whose next approval is addressed to an employee record the directory no longer has. Nobody can act on them, and they appear in no queue — re-address the rung to a person who exists."
        icon={<Unlink className="h-3.5 w-3.5" />}
      />
      <ApprovalExceptionsDesk rows={rows} />
    </div>
  );
}
