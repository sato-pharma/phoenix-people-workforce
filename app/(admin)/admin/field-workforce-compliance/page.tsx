import { redirect } from "next/navigation";

import { FieldWorkforceComplianceWorkspace } from "@/components/field-workforce-compliance/field-workforce-compliance-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function FieldWorkforceCompliancePage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/admin/field-workforce-compliance");
  if (!await canAccess(access, "hr_calendar", "read")) {
    redirect("/employee-portals");
  }

  // The live view reads Phoenix's own iReports360 visits mirror (synced by visits-report),
  // not the CRM directly, so there is no credentials-configured gate to resolve server-side
  // anymore.
  // The Payroll Recommendations tab is hidden from the SFE Manager (owner instruction
  // 2026-08-02): he gets the compliance view, not the payroll side of it. Everyone else who
  // reaches this page keeps it.
  return <FieldWorkforceComplianceWorkspace showPayrollRecommendations={access.role !== "SFE Manager"} />;
}
