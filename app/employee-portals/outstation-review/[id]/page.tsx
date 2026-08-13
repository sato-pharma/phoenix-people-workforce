import { redirect } from "next/navigation";

import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { ManagerOutstationReview } from "@/components/outstation/manager-outstation-review";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getOutstationSubmissionForManager } from "@/lib/outstation/service";

export const dynamic = "force-dynamic";

/**
 * A manager's read-only landing page for ONE direct/indirect report's outstation submission —
 * the destination the "request submitted" notification (notifyOutstationSubmitted) sends his
 * direct manager, skip-level manager, or Super Admin fallback to. Portal-mode roles only:
 * Super Admin lands on the equivalent admin queue view instead (mirrors the redirect pattern in
 * app/employee-portals/approvals/plan/[id]/page.tsx).
 *
 * No approve/reject action lives here on purpose — see the docstring on
 * ManagerOutstationReview and canViewEmployeeExpenseScope in src/lib/outstation/expenses.ts for
 * why the underlying authorization is view-only.
 */
export default async function OutstationReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  const { id } = await params;
  const requestId = Number(id);

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(
      Number.isFinite(requestId)
        ? `/admin/outstation/expense-command?tab=queue&requestId=${encodeURIComponent(id)}`
        : "/admin/outstation/expense-command?tab=queue",
    );
  }

  await assertPermission(access, "expenses", "read");

  if (!Number.isFinite(requestId)) {
    return <EmployeePortalEmptyState message="That outstation request link is invalid." title="Request not found" />;
  }

  let submission: Awaited<ReturnType<typeof getOutstationSubmissionForManager>> = null;
  let loadError: string | null = null;
  try {
    submission = await getOutstationSubmissionForManager(access, requestId);
  } catch (error) {
    // Say the data is unavailable rather than rendering an empty state that reads as "no such
    // request" — those must never look the same on a page reached from a specific notification.
    loadError = error instanceof Error ? error.message : "Unable to load this outstation request.";
  }

  if (loadError) {
    return <EmployeePortalEmptyState message={loadError} title="Outstation request unavailable" />;
  }

  if (!submission) {
    return (
      <EmployeePortalEmptyState
        message="This outstation request is not available, or is outside what you can view."
        title="Request not found"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Expenses"
      description="A read-only summary of this outstation submission."
      errorBoundaryTitle="Outstation request unavailable"
      title={`${submission.employeeName}'s outstation trip`}
    >
      <ManagerOutstationReview submission={submission} />
    </EmployeePortalPageShell>
  );
}
