import { redirect } from "next/navigation";

import { MedicalRepExpensesWorkspace } from "@/components/employee-portal/medical-rep-expenses";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import {
  assertPermission,
  canAccess,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getMedicalRepExpenseContext,
  listMedicalRepExpenseRequests,
} from "@/lib/outstation/service";

export const dynamic = "force-dynamic";

export default async function EmployeePortalExpensesPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/payroll/expenses/dashboard");
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
    if (
      loadError instanceof Error &&
      loadError.message.toLowerCase().includes("only medical rep users can use simple expense submission")
    ) {
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
