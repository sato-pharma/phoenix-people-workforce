import { ExpenseReviewWorkspace } from "@/components/outstation/expense-review/expense-review-workspace";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import {
  canDecideOutstationExpenseApprovals,
  canReviewOutstationExpenseApprovals,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OutstationExpenseApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  // Widened from Super-Admin-only on 2026-08-08 so the CEO can read the claim validation.
  if (!canReviewOutstationExpenseApprovals(access)) {
    redirect("/admin/access");
  }

  // Resolved on the SERVER and passed down, rather than re-derived in the client from a role
  // string: the client cannot be trusted to compute its own authority. This only hides controls —
  // the decision route asserts system-administrator access on its own, so a CEO who reached the
  // buttons anyway would still be refused.
  //
  // Rebuilt from scratch in the Phoenix CRM identity on 2026-11-07 (expense-review/), inside the CRM's
  // admin surface so every dropdown is the combo box you can type into.
  return (
    <CrmSurfaceProvider surface="admin">
      <ExpenseReviewWorkspace canDecide={canDecideOutstationExpenseApprovals(access)} viewerHrId={access.hrId} />
    </CrmSurfaceProvider>
  );
}
