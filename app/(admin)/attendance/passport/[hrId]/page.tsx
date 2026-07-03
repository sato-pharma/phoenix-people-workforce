import { redirect } from "next/navigation";

import { AttendancePassportView } from "@/components/attendance/attendance-passport-view";
import { getAttendancePassport } from "@/lib/attendance/attendance-passport";
import { canAccessAttendanceSetup } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { hrIdsMatch } from "@/lib/hr-id";

export const dynamic = "force-dynamic";

export default async function AttendancePassportDetailPage({ params }: { params: Promise<{ hrId: string }> }) {
  const { hrId } = await params;
  const access = await resolveAccessContextFromPage();

  const isSelf = hrIdsMatch(access.hrId, hrId);
  const isAdmin = await canAccessAttendanceSetup(access, "read");
  if (!isSelf && !isAdmin) {
    redirect("/employee-portals");
  }

  let passport: Awaited<ReturnType<typeof getAttendancePassport>> | null = null;
  let error: string | null = null;
  try {
    passport = await getAttendancePassport(hrId);
  } catch (loadError) {
    error = loadError instanceof Error ? loadError.message : "Attendance passport failed to load.";
  }

  return <AttendancePassportView error={error} passport={passport} searchedHrId={hrId} />;
}
