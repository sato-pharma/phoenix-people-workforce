import { redirect } from "next/navigation";

import { PersonalExpenseWorkloadDashboard } from "@/components/employee-portal/personal-expense-workload-dashboard-dynamic";
import {
  assertPermission,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getMedicalRepPortalData } from "@/lib/employee-portal/service";
import { isMedicalRepExpenseViewer } from "@/lib/outstation/medical-rep-expense-viewer";
import {
  getOwnOutstationTicketCounts,
  getOwnOutstationPendingActions,
  getOwnPendingOutstationReviewRequests,
} from "@/lib/outstation/service";
import { OutstationPendingActions } from "@/components/outstation/outstation-pending-actions";
import { PendingReviewRequestsCard } from "@/components/outstation/pending-review-requests-card";
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";

export const dynamic = "force-dynamic";


export default async function EmployeePortalExpenseDashboardPage() {
  const access = await resolveAccessContextFromPage();
  // A session that expired between the layout's own auth check and this page's client-side
  // navigation resolves to the guest fallback (role "Employee", hrId null) — without this,
  // assertPermission below throws a misleading "Forbidden: Employee cannot read expenses"
  // instead of sending the user back to sign in.
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (canonicalHrIdKey(access.hrId) === "a-3") {
    redirect("/employee-portals");
  }
  const isProductMarketingRole =
    access.role === "Product Manager" ||
    access.role === "Group Product Manager" ||
    access.role === "Marketing Manager";
  if (resolveNavigationMode(access) !== "employee-portal" && !isProductMarketingRole) {
    redirect("/payroll");
  }
  // The one Medical Rep answer the expenses page also reads, so it never sends this viewer back.
  if (isMedicalRepExpenseViewer(access)) {
    redirect("/employee-portals/expenses");
  }
  await assertPermission(access, "expenses", "read");

  let data = null;
  let loadFailed = false;
  try {
    data = await getMedicalRepPortalData(access, {
      includePortalOverview: false,
      includeTeamRank: false,
      includeWorkforceSummary: false,
    });
  } catch {
    // A THROWN READ IS NOT AN UNLINKED PROFILE, and the two were indistinguishable here: this
    // catch set `data = null`, and the branch below tested `!data || data.empty.profile`, so an
    // employee whose data source was simply down was told to contact HR about a linkage problem
    // that does not exist. He then does — and HR finds nothing wrong. AGENTS.md §1: a confident
    // zero is worse than an error, and a confident WRONG REASON is worse than either.
    loadFailed = true;
    data = null;
  }

  if (loadFailed) {
    return (
      <EmployeePortalEmptyState
        message="Your expenses could not be loaded just now. Nothing has been lost — reload the page to try again."
        title="Could not load your expenses"
      />
    );
  }

  if (!data || data.empty.profile) {
    return (
      <EmployeePortalEmptyState
        message="Your employee profile is not linked yet. Please contact HR."
        title="Profile Not Linked"
      />
    );
  }

  const [pendingReviewRequests, ticketCountsByRequestId, pendingActions] = await Promise.all([
    getOwnPendingOutstationReviewRequests(access).catch(() => []),
    getOwnOutstationTicketCounts(access).catch(() => ({})),
    getOwnOutstationPendingActions(access).catch(() => ({ departurePhotoDue: [], missingTicket: [] })),
  ]);
  const { departurePhotoDue, missingTicket } = pendingActions;
  const hasWorkloadRows = Boolean(data.workload?.expenseRows?.length);

  // A request owing a departure photo or a missing ticket must keep the page open even when there is
  // nothing else to show. Without it in this condition, an employee whose only outstation activity
  // is the trip he is standing on would be sent to the empty state and could never capture the
  // photo, or attach the ticket, that releases his own money.
  if (
    !hasWorkloadRows &&
    pendingReviewRequests.length === 0 &&
    departurePhotoDue.length === 0 &&
    missingTicket.length === 0
  ) {
    return (
      <EmployeePortalEmptyState
        message="No visible outstation expense records are available for your expense scope yet."
        title="No outstation expense records"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Expenses"
      description="Review workload, trip volume, and outstation expense movement using the same employee portal workspace design."
      errorBoundaryTitle="Expense Dashboard unavailable"
      title="Expense Dashboard"
    >
      <div className="space-y-5">
        {/* Above the review card on purpose: this one is the only thing on the page the employee
            must ACT on, and it is time-sensitive — the window closes at the end of the trip. */}
        <OutstationPendingActions
          departurePhotoDue={departurePhotoDue}
          employeeHrId={access.hrId ?? ""}
          missingTicket={missingTicket}
        />
        <PendingReviewRequestsCard requests={pendingReviewRequests} />
        {hasWorkloadRows ? (
          <PersonalExpenseWorkloadDashboard
            adminKeyCards={null}
            data={{ workload: data.workload }}
            showHero={false}
            ticketCountsByRequestId={ticketCountsByRequestId}
            viewerHrId={access.hrId}
          />
        ) : null}
      </div>
    </EmployeePortalPageShell>
  );
}
