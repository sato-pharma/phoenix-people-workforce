import { EmployeeManagement } from "@/components/employees/employee-management";
import { AppShell } from "@/components/layout/app-shell";
import {
  employeeDirectoryErrorMessage,
  getEmployeeDirectory,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
} from "@/lib/employees/employee-directory";
import { assertPermission } from "@/lib/auth/permissions";
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
  await assertPermission(access, "employees", "read");
  let initialData = null;
  let initialError: string | null = null;

  try {
    initialData = await getEmployeeDirectory();
  } catch (error) {
    initialError = employeePageError(error);
  }

  return (
    <AppShell>
      <EmployeeManagement
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
