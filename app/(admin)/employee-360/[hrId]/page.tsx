import Link from "next/link";
import { redirect } from "next/navigation";

import { Employee360View, type Employee360Subject } from "@/components/employee-360/employee-360-view";
import { PeriodFilter } from "@/components/employee-360/period-filter";
import { Card } from "@/components/ui/card";
import { canSeeEmployee } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployee360Profile } from "@/lib/employee-360/deep-service";
import { resolvePeriod, type Employee360Comparison } from "@/lib/employee-360/period";
import { getEmployee360Summary } from "@/lib/employee-360/service";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { hrIdsMatch } from "@/lib/hr-id";

export const dynamic = "force-dynamic";

export default async function Employee360DetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ hrId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { hrId } = await params;
  const sp = await searchParams;
  const period = resolvePeriod(sp);
  const access = await resolveAccessContextFromPage();

  const rows = await getEmployeeDirectoryRows({ includeInactive: true });
  const target = rows.find((row) => hrIdsMatch(row.hrId, hrId));

  if (!target) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card>
          <h1 className="text-lg font-semibold text-foreground">Employee not found</h1>
          <p className="mt-1 text-sm text-muted-foreground">No employee record matches “{hrId}”.</p>
          <Link href="/employee-360" className="mt-3 inline-block text-sm text-primary underline">
            ← Back to Employee 360
          </Link>
        </Card>
      </div>
    );
  }

  if (!canSeeEmployee(access, { hrId: target.hrId, managerHrId: target.managerHrId })) {
    redirect("/employee-360");
  }

  const subject: Employee360Subject = {
    hrId: target.hrId,
    displayName: target.displayName || target.fullName,
    jobTitle: target.jobTitle,
    lineName: target.lineName,
    areaName: target.areaName,
    regionName: target.regionName,
    managerName: target.managerName,
    employmentStatus: target.employmentStatus,
    hireDate: target.hireDate,
  };

  // Expense analysis is a MANAGER view (DM / RM / NSM / TM / PM / GPM). Hide the whole
  // Expenses & Outstation section when the subject is a Medical Rep. Job-function
  // classification (not the security role parser) is the right, sanctioned source here.
  const showExpenses = resolveJobFunctionRole(target.jobTitle ?? target.positionTitle) !== "Medical Rep";

  const nameByHrId = new Map<string, string>(
    rows.map((row) => [row.hrId.trim().toLowerCase(), row.displayName || row.fullName]),
  );

  // Team roll-up: subject + ALL descendants in the org tree. A manager's sales are
  // the sum of their whole team's sales/target (DM = their reps, NSM = the line).
  const childrenByManager = new Map<string, string[]>();
  for (const row of rows) {
    const mgr = row.managerHrId ? row.managerHrId.trim().toLowerCase() : null;
    if (!mgr) continue;
    const list = childrenByManager.get(mgr) ?? [];
    list.push(row.hrId);
    childrenByManager.set(mgr, list);
  }
  const teamHrIds: string[] = [target.hrId];
  const seenTeam = new Set<string>([target.hrId.trim().toLowerCase()]);
  const queue = [target.hrId.trim().toLowerCase()];
  while (queue.length && teamHrIds.length < 1000) {
    const current = queue.shift() as string;
    for (const child of childrenByManager.get(current) ?? []) {
      const key = child.trim().toLowerCase();
      if (seenTeam.has(key)) continue;
      seenTeam.add(key);
      teamHrIds.push(child);
      queue.push(key);
    }
  }

  let summary: Awaited<ReturnType<typeof getEmployee360Profile>> | null = null;
  let previous: Awaited<ReturnType<typeof getEmployee360Summary>> | null = null;
  let error: string | null = null;
  try {
    const [cur, prev] = await Promise.all([
      getEmployee360Profile(target.hrId, nameByHrId, period.current, teamHrIds),
      getEmployee360Summary(target.hrId, period.previous),
    ]);
    summary = cur;
    previous = prev;
  } catch (loadError) {
    error = loadError instanceof Error ? loadError.message : "Failed to load profile data.";
  }

  const backAndFilter = (
    <div className="mx-auto max-w-5xl space-y-3 px-4 pt-4 sm:px-6">
      <Link href="/employee-360" className="text-sm text-muted-foreground hover:text-foreground">
        ← All employees
      </Link>
      <PeriodFilter hrId={subject.hrId} activeKey={period.key} from={period.current.from} to={period.current.to} />
    </div>
  );

  if (!summary) {
    return (
      <div>
        {backAndFilter}
        <div className="mx-auto max-w-3xl p-6">
          <Card>
            <h1 className="text-lg font-semibold text-foreground">{subject.displayName}</h1>
            <p className="mt-2 text-sm text-destructive">{error ?? "No data."}</p>
          </Card>
        </div>
      </div>
    );
  }

  const comparison: Employee360Comparison | null = previous
    ? {
        previousLabel: period.previous.label,
        productiveVisits: { cur: summary.productiveVisits, prev: previous.productiveVisits },
        visitsPerActiveDay: { cur: summary.visitsPerActiveDay, prev: previous.visitsPerActiveDay },
        distinctCustomers: { cur: summary.distinctCustomers, prev: previous.distinctCustomers },
        campaignShare: { cur: summary.campaignShare, prev: previous.campaignShare },
        checkinCoverage: { cur: summary.checkinCoverage, prev: previous.checkinCoverage },
        checkinCount: { cur: summary.checkinCount, prev: previous.checkinCount },
      }
    : null;

  return (
    <div>
      {backAndFilter}
      <Employee360View subject={subject} summary={summary} comparison={comparison} showExpenses={showExpenses} />
    </div>
  );
}
