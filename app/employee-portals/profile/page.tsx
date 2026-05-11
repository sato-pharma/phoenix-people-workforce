import { redirect } from "next/navigation";
import { EmployeePortalPageShell, EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { EmployeeProfileCard } from "@/components/employee-portal/employee-profile-card";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";

export const dynamic = "force-dynamic";

export default async function EmployeePortalProfilePage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  await assertPermission(access, "employee_profile", "read");

  // Get employee data
  const directory = await getEmployeeDirectory();
  const currentEmployee = directory?.employees.find((emp) => emp.hrId === access.hrId);

  if (!currentEmployee) {
    return (
      <EmployeePortalPageShell
        description="Your complete employee profile information"
        title="Profile"
      >
        <EmployeePortalEmptyState
          message="Your profile information could not be loaded. Please try again or contact HR."
          title="Profile Unavailable"
        />
      </EmployeePortalPageShell>
    );
  }

  return (
    <EmployeePortalPageShell
      description="Your complete employee profile information"
      title="Profile"
    >
      <EmployeeProfileCard employee={currentEmployee} />
    </EmployeePortalPageShell>
  );
}
