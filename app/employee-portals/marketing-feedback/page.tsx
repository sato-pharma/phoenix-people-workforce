import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { FieldFeedbackBoardBody } from "@/components/marketing-functions/page-bodies";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Marketing Field Visit Feedback (owner, 2026-11-10): the forms and the Rep Tracking. Inline gate, as on
 * every portal page. Who sees which form is decided in the service: the Product Manager his own, the
 * National Sales Manager the signed forms on his own line's reps, the readers above every signed form.
 */
export default async function EmployeePortalMarketingFeedbackPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/marketing-feedback");
  }
  if (!(await canAccess(access, "marketing_field_feedback", "read"))) {
    redirect("/employee-portals");
  }
  const params = await searchParams;

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="One form per single or double visit with a representative, and the tracking of each representative's strengths and gaps over time."
      title="Marketing Field Visit Feedback"
    >
      <FieldFeedbackBoardBody access={access} basePath="/employee-portals/marketing-feedback" params={params} />
    </EmployeePortalPageShell>
  );
}
