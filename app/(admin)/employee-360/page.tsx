import { Users } from "lucide-react";

import {
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
} from "@/components/admin/admin-design-system";
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
      regionName: row.regionName,
      managerName: row.managerName,
      employmentStatus: row.employmentStatus,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const lineCount = new Set(employees.map((e) => e.lineName).filter(Boolean)).size;
  const areaCount = new Set(employees.map((e) => e.areaName).filter(Boolean)).size;
  const jobTitleCount = new Set(employees.map((e) => e.jobTitle).filter(Boolean)).size;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <AdminPageHero
        eyebrow="PEOPLE INTELLIGENCE"
        title="Employee 360"
        description="One consolidated profile per person — field visits, campaign-vs-regular balance, GPS check-in timing, sales, coaching, expenses, and impact, all in a single report. Pick a person below to open it."
        icon={<Users className="h-3.5 w-3.5" />}
        badges={
          <>
            <AdminInsightChip tone="orange">{employees.length} visible to you</AdminInsightChip>
            <AdminInsightChip>{lineCount} lines · {areaCount} areas</AdminInsightChip>
          </>
        }
      />

      {employees.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">
            No employees are visible to your role here.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <AdminStatCard
              tone="orange"
              size="compact"
              icon={<Users className="h-4 w-4" />}
              label="Employees"
              value={employees.length}
              description="Visible to your role"
            />
            <AdminStatCard
              tone="blue"
              size="compact"
              icon={<Users className="h-4 w-4" />}
              label="Lines"
              value={lineCount}
              description="Distinct sales/field lines"
            />
            <AdminStatCard
              tone="emerald"
              size="compact"
              icon={<Users className="h-4 w-4" />}
              label="Areas"
              value={areaCount}
              description="Distinct geographic areas"
            />
            <AdminStatCard
              tone="violet"
              size="compact"
              icon={<Users className="h-4 w-4" />}
              label="Job titles"
              value={jobTitleCount}
              description="Distinct roles represented"
            />
          </div>

          <EmployeeSearchList employees={employees} />
        </>
      )}
    </div>
  );
}
