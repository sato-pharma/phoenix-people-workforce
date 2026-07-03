import { redirect } from "next/navigation";

import { AttendancePassportView } from "@/components/attendance/attendance-passport-view";
import { canAccessAttendanceSetup } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendancePassportSearchPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccessAttendanceSetup(access, "read")) {
    redirect("/employee-portals");
  }

  return <AttendancePassportView error={null} passport={null} />;
}
