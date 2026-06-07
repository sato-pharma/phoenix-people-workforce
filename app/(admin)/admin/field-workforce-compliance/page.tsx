import { redirect } from "next/navigation";

import { FieldWorkforceComplianceWorkspace } from "@/components/field-workforce-compliance/field-workforce-compliance-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isIReports360Configured } from "@/lib/field-workforce-compliance/ireports360-config";

export const dynamic = "force-dynamic";

export default async function FieldWorkforceCompliancePage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "hr_calendar", "read")) {
    redirect("/employee-portals");
  }

  // Resolve the integration's availability server-side so the workspace can show
  // the live-import control only when the iReports360 credentials are present.
  // Otherwise the button would POST and come back with a raw 503.
  return <FieldWorkforceComplianceWorkspace ireports360Configured={isIReports360Configured()} />;
}
