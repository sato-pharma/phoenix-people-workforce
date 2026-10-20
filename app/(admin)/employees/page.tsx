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

export default async function EmployeesPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  if (!await canAccess(access, "employees", "read")) {
    redirect("/employee-portals");
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          title="Loading Employees"
          description="Preparing directory, hierarchy, compensation, and lookup data."
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

  // The page admits anyone with employees:read, but the write controls need employees:update —
  // exactly what POST /api/employees asserts. Passing the real capability is what let the sidebar
  // row move from `update` to `read` (src/config/system-navigation.ts): before this prop existed,
  // offering the page to a reader meant offering her Save buttons the API refuses.
  const canEdit = await canAccess(access, "employees", "update");
  // Adding a person is its own grant since the HR Operations Specialist seat, which edits the
  // master but does not add to it; POST /api/employees asserts it on every create.
  const canCreate = await canAccess(access, "employees", "create");
  // Resign and Declined call routes that also assert resignations:create (and vacancies:create).
  // The HR Operations Specialist edits the master without recording departures — the owner
  // submits a resignation and she follows it up — so canEdit alone would offer her a 403.
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
