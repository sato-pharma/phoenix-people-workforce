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
import { shouldBounceToExpenseDashboard } from "@/lib/outstation/medical-rep-expense-viewer";
import {
  getMedicalRepExpenseContext,
  listMedicalRepExpenseRequests,
} from "@/lib/outstation/service";

export const dynamic = "force-dynamic";

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

    return (
      <EmployeePortalEmptyState
        message={
          loadError instanceof Error
            ? loadError.message
            : "Unable to load your outstation expense workspace."
        }
        title="Outstation Expenses Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      description="Simple outstation expense submission with residence as the fixed origin."
      title="My Outstation Expenses"
    >
      <MedicalRepExpensesWorkspace
        canSubmit={Boolean(context.fromLocation) && canSubmitExpense}
        employeeName={context.employeeName}
        initialRequests={requests}
        residenceSummary={context.fromLocation}
      />
    </EmployeePortalPageShell>
  );
}
