import { Users } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import {
  EmployeeSearchList,
  type Employee360ListItem,
} from "@/components/employee-360/employee-search-list";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { resolveEmployee360VisibleRows } from "@/lib/employee-360/access";
import { resolveEmployee360RoleCategory } from "@/lib/employee-360/roles";
import { bridgeEmployeeLineToOfficial } from "@/lib/sales/access-scope";

export const dynamic = "force-dynamic";

export default async function Employee360IndexPage() {
  const access = await resolveAccessContextFromPage();
  const rows = await getEmployeeDirectoryRows({ includeInactive: false });

  // Employee 360 is a FIELD-FORCE report: only the six covered role families appear.
  // Everyone else (HR, Finance, CEO, admin, office…) is excluded entirely. The
  // 360-specific gate opens the module to every role but scopes WHO each viewer
  // sees (self / team / hierarchy / line / reps / whole company).
  const employees: Employee360ListItem[] = resolveEmployee360VisibleRows(rows, access)
    .map((row) => {
      const category = resolveEmployee360RoleCategory(row.jobTitle ?? row.positionTitle);
      if (!category) return null;
      return {
        hrId: row.hrId,
        displayName: row.displayName || row.fullName,
        jobTitle: row.jobTitle,
        // Canonicalize the line name so the duplicate master rows ("Anti Inf"
        // id=53 vs "Anti infective" id=1) collapse to ONE line in the filter,
        // cards, and hero. Single source of truth for line spelling.
        lineName: bridgeEmployeeLineToOfficial(row.lineName),
        areaName: row.areaName,
        regionName: row.regionName,
        managerName: row.managerName,
        employmentStatus: row.employmentStatus,
        category,
      } satisfies Employee360ListItem;
    })
    .filter((e): e is Employee360ListItem => e !== null)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const lineCount = new Set(employees.map((e) => e.lineName).filter(Boolean)).size;
  const areaCount = new Set(employees.map((e) => e.areaName).filter(Boolean)).size;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <AdminPageHero
        eyebrow="PEOPLE INTELLIGENCE"
        title="Employee 360"
        description="One consolidated profile per person, tailored to their role. Pick a tab for the field-force family you want, then open a person — each role's report shows the metrics that matter for what they actually do."
        icon={<Users className="h-3.5 w-3.5" />}
        badges={
          <>
            <AdminInsightChip tone="orange">{employees.length} in the field force</AdminInsightChip>
            <AdminInsightChip>{lineCount} lines · {areaCount} areas</AdminInsightChip>
          </>
        }
      />

      {employees.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">
            No field-force employees are visible to your role here.
          </p>
        </Card>
      ) : (
        <EmployeeSearchList employees={employees} />
      )}
    </div>
  );
}
