import { redirect } from "next/navigation";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { FieldFeedbackBoardBody } from "@/components/marketing-functions/page-bodies";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** The admin-shell twin of the Marketing Field Visit Feedback board. Signed forms only. */
export default async function AdminMarketingFeedbackPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/marketing-feedback");
  }
  if (!(await canAccess(access, "marketing_field_feedback", "read"))) {
    redirect("/overview");
  }
  const params = await searchParams;

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Marketing Field Visit Feedback</h1>
          <p className={pageHeaderDescriptionClassName}>
            The Product Managers’ signed field visit forms, and each representative’s strengths and recurring gaps over time.
          </p>
        </div>
      </div>

      <FieldFeedbackBoardBody access={access} basePath="/admin/marketing-feedback" newHref={null} params={params} />
    </div>
  );
}
