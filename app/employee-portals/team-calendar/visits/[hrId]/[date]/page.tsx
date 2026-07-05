import { redirect } from "next/navigation";

import { FieldWorkforceVisitsView } from "@/components/field-workforce-compliance/field-workforce-visits-view";
import { isNationalSalesManager, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isHrIdInNsmTeamScope } from "@/lib/employee-portal/team-calendar";

export const dynamic = "force-dynamic";

export default async function TeamCalendarVisitsPage({
  params,
}: {
  params: Promise<{ date: string; hrId: string }>;
}) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  if (!isNationalSalesManager(access.role)) {
    redirect("/employee-portals");
  }

  const { date, hrId } = await params;
  const decodedHrId = decodeURIComponent(hrId);

  // Only reps inside the NSM's own line — never an arbitrary HR ID from the URL.
  if (!(await isHrIdInNsmTeamScope(access, decodedHrId))) {
    redirect("/employee-portals/team-calendar");
  }

  return (
    <FieldWorkforceVisitsView
      backHref="/employee-portals/team-calendar"
      backLabel="Back to Team Calendar"
      date={date}
      endpoint="/api/employee-portals/team-calendar/visits"
      hrId={decodedHrId}
    />
  );
}
