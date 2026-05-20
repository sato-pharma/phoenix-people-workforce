import { redirect } from "next/navigation";

import { MedicalRepExpensesWorkspace } from "@/components/employee-portal/medical-rep-expenses";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
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

  if (access.role !== "Medical Rep") {
    redirect("/employee-portals/expense-dashboard");
  }

  await assertPermission(access, "outstation", "create");

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
    return (
      <EmployeePortalEmptyState
        message={
          loadError instanceof Error
            ? loadError.message
            : "Unable to load your expense submission workspace."
        }
        title="Expenses Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      description="Simple traveling expense submission with residence as the fixed origin."
      title="Expenses"
    >
      <MedicalRepExpensesWorkspace
        canSubmit={Boolean(context.fromLocation)}
        employeeName={context.employeeName}
        initialRequests={requests}
        residenceSummary={context.fromLocation}
      />
    </EmployeePortalPageShell>
  );
}
