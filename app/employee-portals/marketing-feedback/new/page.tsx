import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { FieldFeedbackNewBody } from "@/components/marketing-functions/page-bodies";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

/** A new Marketing Field Visit Feedback form. Only a Product Manager fills it (the route re-checks). */
export default async function EmployeePortalMarketingFeedbackNewPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/marketing-feedback");
  }
  if (!(await canAccess(access, "marketing_field_feedback", "create"))) {
    redirect("/employee-portals/marketing-feedback");
  }

  return (
    <EmployeePortalPageShell badge="Marketing" description="Start from a logged field day or enter the visit by hand." title="Marketing Field Visit Feedback">
      <FieldFeedbackNewBody access={access} basePath="/employee-portals/marketing-feedback" />
    </EmployeePortalPageShell>
  );
}
