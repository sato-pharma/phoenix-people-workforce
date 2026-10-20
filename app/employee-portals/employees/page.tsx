import { redirect } from "next/navigation";
import { Suspense } from "react";

import { EmployeeManagement } from "@/components/employees/employee-management";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { isSalaryBlindRole } from "@/lib/auth/hr-functions";
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

  // THE SAME PROP THE ADMIN COPY PASSES, and it was missing here. The page is a mirror of
  // app/(admin)/employees/page.tsx, which computes this precisely so a reader is not offered Save
  // buttons the API refuses — and the mirror never got it, so every viewer who reached this page
  // was handed edit controls whatever their grant.
  //
  // Nobody was affected: no role currently holds `employees:read` AND resolves to the portal
  // shell, so the gate above redirects everyone before they get here (measured 2026-09-09). That
  // is exactly why it never showed up — it is a hole waiting for the first portal seat to be
  // granted the employee master, not a live fault.
  const canEdit = await canAccess(access, "employees", "update");
  // The same two props the admin copy passes, for the same reasons.
  const canCreate = await canAccess(access, "employees", "create");
  const canStartResignation = await canAccess(access, "resignations", "create");

  return (
    <EmployeeManagement
      canCreate={canCreate}
      canEdit={canEdit}
      canStartResignation={canStartResignation}
      initialData={initialData}
      initialError={initialError}
      salaryBlind={isSalaryBlindRole(access.role)}
    />
  );
}
