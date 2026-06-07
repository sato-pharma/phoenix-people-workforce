import { redirect } from "next/navigation";

import { FieldWorkforceVisitsView } from "@/components/field-workforce-compliance/field-workforce-visits-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function FieldWorkforceVisitsPage({
  params,
}: {
  params: Promise<{ date: string; hrId: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "hr_calendar", "read")) {
    redirect("/employee-portals");
  }

  const { date, hrId } = await params;
  return <FieldWorkforceVisitsView date={date} hrId={decodeURIComponent(hrId)} />;
}
