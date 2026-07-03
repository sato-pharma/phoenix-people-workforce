import { redirect } from "next/navigation";

import { FieldWorkforceComplianceWorkspace } from "@/components/field-workforce-compliance/field-workforce-compliance-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function FieldWorkforceCompliancePage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "hr_calendar", "read")) {
    redirect("/employee-portals");
  }

  // The live view reads Phoenix's own iReports360 visits mirror (synced by visits-report),
  // not the CRM directly, so there is no credentials-configured gate to resolve server-side
  // anymore.
  return <FieldWorkforceComplianceWorkspace />;
}
