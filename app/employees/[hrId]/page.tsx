import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { EmployeeMasterDetail } from "@/components/employees/employee-master-detail";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getEmployeeDirectory,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";

export const dynamic = "force-dynamic";

export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ hrId: string }>;
}) {
  const { hrId } = await params;
  const access = await resolveAccessContextFromPage();

  // Check if user has employees access
  if (resolveNavigationMode(access) !== "admin") {
    redirect("/overview");
  }
  await assertPermission(access, "employees", "read");

  // Fetch employee directory
  let directory;
  try {
    directory = await getEmployeeDirectory();
  } catch (error) {
    console.error("Failed to load employee directory:", error);
    return (
      <AppShell navigationMode="admin">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6">
          <h2 className="text-lg font-semibold text-red-900">
            Unable to Load Employee Data
          </h2>
          <p className="mt-2 text-sm text-red-800">
            There was an error loading the employee directory. Please try again
            or contact support.
          </p>
        </div>
      </AppShell>
    );
  }

  // Find employee by hrId
  const employee = directory?.employees.find((emp) => emp.hrId === hrId);

  if (!employee) {
    return (
      <AppShell navigationMode="admin">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6">
          <h2 className="text-lg font-semibold text-red-900">
            Employee Not Found
          </h2>
          <p className="mt-2 text-sm text-red-800">
            The employee with HR_ID "{hrId}" could not be found in the system.
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell navigationMode="admin">
      <EmployeeMasterDetail
        employee={employee}
        lookups={directory.lookups}
      />
    </AppShell>
  );
}
