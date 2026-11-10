import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { FieldFeedbackDetailBody } from "@/components/marketing-functions/page-bodies";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ id: string }> };

/** One form: editable by its Product Manager until he signs it, read-only for everyone allowed to see it. */
export default async function EmployeePortalMarketingFeedbackDetailPage({ params }: PageProps) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`/admin/marketing-feedback/${encodeURIComponent(id)}`);
  }
  if (!(await canAccess(access, "marketing_field_feedback", "read"))) {
    redirect("/employee-portals");
  }

  return (
    <EmployeePortalPageShell badge="Marketing" description="The feedback from one field visit." title="Marketing Field Visit Feedback">
      <FieldFeedbackDetailBody access={access} basePath="/employee-portals/marketing-feedback" id={id} />
    </EmployeePortalPageShell>
  );
}
