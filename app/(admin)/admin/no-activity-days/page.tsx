import { redirect } from "next/navigation";

import { NoActivityDaysWorkspace } from "@/components/admin/no-activity-days-workspace";
import { PremiumHero } from "@/components/ui/premium-hero";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveCopilotCycleWindow } from "@/lib/payroll/copilot/deductions-review";
import { getCompanyNoActivityReport } from "@/lib/private-calendar/no-activity-clarifications";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminNoActivityDaysPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (access.role !== "Super Admin") {
    redirect("/employee-portals");
  }

  const resolved = await searchParams;
  const getString = (key: string) => {
    const value = resolved[key];
    return Array.isArray(value) ? value[0] : (value ?? null);
  };
  const now = new Date();
  const month = Math.max(1, Math.min(12, Number(getString("month")) || now.getUTCMonth() + 1));
  const year = Number(getString("year")) || now.getUTCFullYear();

  let initialRows: Awaited<ReturnType<typeof getCompanyNoActivityReport>> = [];
  let initialCycle: { cycleKey: string; endIso: string; startIso: string } | null = null;
  let initialError: string | null = null;
  try {
    const cycle = await resolveCopilotCycleWindow({ month, year });
    initialCycle = cycle;
    initialRows = await getCompanyNoActivityReport(access, { end: cycle.endIso, start: cycle.startIso });
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Unable to load the No Activity Days report.";
  }

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Deductions Governance"
        title="No Activity Days"
        subtitle="Every Private Calendar 'No Activity Recorded' day across the company, with the employee's clarification (if any) and the payroll deduction decision."
      />
      <NoActivityDaysWorkspace initialCycle={initialCycle} initialError={initialError} initialMonth={month} initialRows={initialRows} initialYear={year} />
    </div>
  );
}
