import { Card } from "@/components/ui/card";
import {
  EmployeeSearchList,
  type Employee360ListItem,
} from "@/components/employee-360/employee-search-list";
import { canSeeEmployee } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";

export const dynamic = "force-dynamic";

export default async function Employee360IndexPage() {
  const access = await resolveAccessContextFromPage();
  const rows = await getEmployeeDirectoryRows({ includeInactive: false });

  const employees: Employee360ListItem[] = rows
    .filter((row) => canSeeEmployee(access, { hrId: row.hrId, managerHrId: row.managerHrId }))
    .map((row) => ({
      hrId: row.hrId,
      displayName: row.displayName || row.fullName,
      jobTitle: row.jobTitle,
      lineName: row.lineName,
      areaName: row.areaName,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Employee 360</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One consolidated view per employee. v1 shows field visits, campaign-vs-regular balance,
          and GPS check-in timing. Pick a person to open their profile.
        </p>
      </div>

      {employees.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">
            No employees are visible to your role here.
          </p>
        </Card>
      ) : (
        <EmployeeSearchList employees={employees} />
      )}
    </div>
  );
}
