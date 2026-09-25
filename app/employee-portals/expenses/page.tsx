import { redirect } from "next/navigation";

import { MedicalRepExpensesWorkspace } from "@/components/employee-portal/medical-rep-expenses";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import {
  assertPermission,
  canAccess,
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { shouldBounceToExpenseDashboard } from "@/lib/outstation/medical-rep-expense-viewer";
// A separate line on purpose: tests/medical-rep-expense-viewer.test.ts pins the line above verbatim.
import { MEDICAL_REP_ONLY_EXPENSE_REFUSAL } from "@/lib/outstation/medical-rep-expense-viewer";
import {
  getMedicalRepExpenseContext,
  listMedicalRepExpenseRequests,
} from "@/lib/outstation/service";

export const dynamic = "force-dynamic";

// The sidebar's own words: "My Outstation Expenses" under "Pay & Expenses". The unavailable state
// keeps the same header, so the page never loses its title when the data does not load.
const PAGE_BADGE = "Pay & Expenses";
const PAGE_TITLE = "My Outstation Expenses";
const PAGE_DESCRIPTION =
  "Claim your travel tickets and follow every claim you have sent. Each trip starts from your home address on file.";

export default async function EmployeePortalExpensesPage() {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) !== "employee-portal") {
    if (!canAccessSystemAdministratorWorkspace(access)) {
      redirect("/admin/access");
    }
    redirect("/admin/outstation/expenses/dashboard");
  }

  await assertPermission(access, "expenses", "read");
  const canSubmitExpense = await canAccess(access, "outstation", "create");

  let context: Awaited<ReturnType<typeof getMedicalRepExpenseContext>> | null = null;
  let requests: Awaited<ReturnType<typeof listMedicalRepExpenseRequests>> = [];
  let loadError: unknown = null;

  try {
    const [resolvedContext, resolvedRequests] = await Promise.all([
      getMedicalRepExpenseContext(access),
      listMedicalRepExpenseRequests(access),
    ]);
    context = resolvedContext;
    requests = resolvedRequests;
  } catch (error) {
    loadError = error;
  }

  if (!context) {
    // Never for a viewer the dashboard would send straight back here — that pair looped forever.
    // Such a viewer gets the empty state below, which names the refusal.
    if (shouldBounceToExpenseDashboard(access, loadError)) {
      redirect("/employee-portals/expense-dashboard");
    }

    // The technical reason goes to the server log, never the screen. The one refusal a person CAN act
    // on — their HR job title is not Medical Rep, which is a data fix — is named in plain words; it is
    // recognised by the shared constant the service throws, never a string of this page's own.
    if (loadError) {
      logPortalFailure(
        { route: "/employee-portals/expenses", module: "expenses", role: access.role, hrId: access.hrId },
        loadError,
      );
    }
    const refusedByJobTitle =
      loadError instanceof Error && loadError.message.includes(MEDICAL_REP_ONLY_EXPENSE_REFUSAL);

    return (
      <EmployeePortalPageShell badge={PAGE_BADGE} description={PAGE_DESCRIPTION} title={PAGE_TITLE}>
        <EmployeePortalEmptyState
          message={
            refusedByJobTitle
              ? "Your HR record does not list your job title as Medical Rep, so this page cannot open for you. Please ask HR to check your job title."
              : "We could not load your outstation expenses right now. Please try again in a moment."
          }
          title="Outstation Expenses Unavailable"
        />
      </EmployeePortalPageShell>
    );
  }

  return (
    <EmployeePortalPageShell badge={PAGE_BADGE} description={PAGE_DESCRIPTION} title={PAGE_TITLE}>
      <MedicalRepExpensesWorkspace
        canSubmit={Boolean(context.fromLocation) && canSubmitExpense}
        employeeName={context.employeeName}
        initialRequests={requests}
        residenceSummary={context.fromLocation}
      />
    </EmployeePortalPageShell>
  );
}
