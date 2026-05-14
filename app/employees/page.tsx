import { EmployeeManagement } from "@/components/employees/employee-management";
import { AppShell } from "@/components/layout/app-shell";
import { redirect } from "next/navigation";
import {
  employeeDirectoryErrorMessage,
  getEmployeeDirectory,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
} from "@/lib/employees/employee-directory";
import { canAccess, filterEmployeeDirectoryForAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

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
  if (!await canAccess(access, "employees", "read")) {
    redirect("/employee-portals");
  }
  let initialData = null;
  let initialError: string | null = null;

  try {
    initialData = filterEmployeeDirectoryForAccess(await getEmployeeDirectory(), access);
  } catch (error) {
    initialError = employeePageError(error);
  }

  return (
    <AppShell navigationMode="admin">
      <EmployeeManagement
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
