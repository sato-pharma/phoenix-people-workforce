import { redirect } from "next/navigation";

import { MonthlyAttendanceSummary } from "@/components/attendance/monthly-attendance-summary";
import { getMonthlyAttendanceSummary, resolveSummaryMonth } from "@/lib/attendance/monthly-summary";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ month?: string }>;
};

export default async function AttendanceMonthlySummaryPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "employees", "read")) {
    redirect("/employee-portals");
  }
  const canGenerateCandidates = await canAccess(access, "attendance", "create");

  const filters = await searchParams;
  const month = resolveSummaryMonth(filters?.month);

  let initialData = null;
  let initialError: string | null = null;
  try {
    initialData = await getMonthlyAttendanceSummary({ month });
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Monthly attendance summary failed to load.";
  }

  return (
    <MonthlyAttendanceSummary
      key={month}
      canGenerateCandidates={canGenerateCandidates}
      initialData={initialData}
      initialError={initialError}
      month={month}
    />
  );
}
