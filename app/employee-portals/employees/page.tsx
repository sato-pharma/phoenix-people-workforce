import { redirect } from "next/navigation";
import { Suspense } from "react";

import { EmployeeManagement } from "@/components/employees/employee-management";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, filterEmployeeDirectoryForAccess, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  employeeDirectoryErrorMessage,
  getEmployeeDirectory,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
} from "@/lib/employees/employee-directory";

export const dynamic = "force-dynamic";

function employeePageError(error: unknown) {
  if (isEmployeeDirectoryTimeout(error)) {
    return "Supabase request timed out. Check your connection and try again.";
  }
  if (isEmployeeDirectoryEnvMissing(error)) {
    return "Supabase environment variables are missing.";
  }
  if (isEmployeeDirectorySchemaMissing(error)) {
    return "Supabase schema is not ready. Run supabase/phoenix-schema.sql in Supabase SQL editor.";
  }
  return employeeDirectoryErrorMessage(error);
}

// Portal mirror of app/(admin)/employees/page.tsx.
export default async function EmployeePortalEmployeesPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/employees");
  }
  if (!(await canAccess(access, "employees", "read"))) {
    redirect("/employee-portals");
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          description="Preparing directory, hierarchy, compensation, and lookup data."
          title="Loading Employees"
        />
      }
    >
      <EmployeesContent access={access} />
    </Suspense>
  );
}

async function EmployeesContent({ access }: { access: AccessContext }) {
  let initialData = null;
  let initialError: string | null = null;

  try {
    initialData = filterEmployeeDirectoryForAccess(await getEmployeeDirectory(), access);
  } catch (error) {
    initialError = employeePageError(error);
  }

  return (
    <EmployeeManagement
      initialData={initialData}
      initialError={initialError}
    />
  );
}
