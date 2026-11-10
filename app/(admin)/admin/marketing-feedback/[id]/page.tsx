import { redirect } from "next/navigation";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { FieldFeedbackDetailBody } from "@/components/marketing-functions/page-bodies";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ id: string }> };

/** One signed field visit form, in the admin shell. */
export default async function AdminMarketingFeedbackDetailPage({ params }: PageProps) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/marketing-feedback/${encodeURIComponent(id)}`);
  }
  if (!(await canAccess(access, "marketing_field_feedback", "read"))) {
    redirect("/overview");
  }

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Marketing Field Visit Feedback</h1>
          <p className={pageHeaderDescriptionClassName}>
            The feedback from one field visit.
          </p>
        </div>
      </div>

      <FieldFeedbackDetailBody access={access} basePath="/admin/marketing-feedback" id={id} />
    </div>
  );
}
