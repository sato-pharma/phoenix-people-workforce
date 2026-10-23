import { redirect } from "next/navigation";

import { FingerprintReport } from "@/components/attendance/fingerprint-report";
import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { canAccessFingerprintReport } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
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
  guardSeatPage(access, "/attendance/fingerprint-report");
  if (!await canAccessFingerprintReport(access)) {
    redirect("/employee-portals");
  }

  const filters = await searchParams;
  let initialData = null;
  let initialError: string | null = null;

  try {
    initialData = await getFingerprintAttendanceReport(filters);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Fingerprint attendance report failed to load.";
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
