import { redirect } from "next/navigation";

import { FingerprintReport } from "@/components/attendance/fingerprint-report";
import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{
    dateFrom?: string;
    dateTo?: string;
    deduction?: string;
    department?: string;
    deviceUserId?: string;
    employeeHrId?: string;
    employeeName?: string;
    jobTitle?: string;
    search?: string;
    status?: string;
  }>;
};

export default async function AttendanceFingerprintReportPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "employees", "read")) {
    redirect("/employee-portals");
  }

  const filters = await searchParams;
  let initialData = null;
  let initialError: string | null = null;

  try {
    initialData = await getFingerprintAttendanceReport(filters);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "My Attendance report failed to load.";
  }

  const reportKey = [
    filters?.dateFrom ?? "",
    filters?.dateTo ?? "",
    filters?.deduction ?? "",
    filters?.department ?? "",
    filters?.deviceUserId ?? "",
    filters?.employeeHrId ?? "",
    filters?.employeeName ?? "",
    filters?.jobTitle ?? "",
    filters?.search ?? "",
    filters?.status ?? "",
  ].join("|");

  return (
    <FingerprintReport key={reportKey} initialData={initialData} initialError={initialError} />
  );
}
