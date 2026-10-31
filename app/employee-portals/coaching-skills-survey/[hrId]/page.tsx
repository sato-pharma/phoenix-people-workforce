import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { SkillsSurveyForm } from "@/components/coaching/skills-survey/skills-survey-form";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { phxButtonGhostClassName } from "@/components/ui/form-kit";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContextFromPage } from "@/lib/auth/server";
import { canOpenSkillsSurvey } from "@/lib/coaching/skills-survey/access";
import { parseSkillsSurveyQuarterKey } from "@/lib/coaching/skills-survey/calculations";
import {
  getSkillsSurveyMemberForm,
  SkillsSurveyError,
  type SkillsSurveyMemberForm,
} from "@/lib/coaching/skills-survey/service";
import { skillsSurveyTitle } from "@/lib/coaching/skills-survey/vocabulary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One team member's survey: the District Manager's form for this quarter, or an earlier quarter's
// survey, read only. The person rated is refused here, whatever his role.

type PageProps = {
  params: Promise<{ hrId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const listHref = "/employee-portals/coaching-skills-survey";

export default async function CoachingSkillsSurveyMemberPortalPage({ params, searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  const { hrId } = await params;
  const memberHrId = decodeURIComponent(hrId);
  const query = await searchParams;
  const quarterParam = Array.isArray(query.quarter) ? query.quarter[0] : query.quarter;
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(
      `/coaching/skills-survey/${encodeURIComponent(memberHrId)}${quarterParam ? `?quarter=${encodeURIComponent(quarterParam)}` : ""}`,
    );
  }

  if (!canOpenSkillsSurvey(access) || !(await canAccess(access, "coaching_skills_survey", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="This survey is for managers and the Training Manager."
        title="Survey unavailable"
      />
    );
  }

  let form: SkillsSurveyMemberForm;
  try {
    form = await getSkillsSurveyMemberForm(access, memberHrId, { quarter: parseSkillsSurveyQuarterKey(quarterParam) });
  } catch (error) {
    if (isForbiddenError(error)) {
      return (
        <EmployeePortalEmptyState message="You cannot open this team member's survey." title="Survey unavailable" />
      );
    }
    if (error instanceof SkillsSurveyError) {
      return <EmployeePortalEmptyState message={error.message} title="Survey unavailable" />;
    }
    throw error;
  }

  return (
    <EmployeePortalPageShell
      badge="Field Coaching"
      description={`${form.member.name}${form.districtName ? ` · ${form.districtName}` : ""}`}
      errorBoundaryTitle="The survey is unavailable"
      title={skillsSurveyTitle}
    >
      <div className="space-y-4">
        <Link className={phxButtonGhostClassName} href={listHref}>
          <ChevronLeft className="h-4 w-4" />
          Back to the survey
        </Link>
        <SkillsSurveyForm backHref={listHref} form={form} variant="portal" />
      </div>
    </EmployeePortalPageShell>
  );
}
