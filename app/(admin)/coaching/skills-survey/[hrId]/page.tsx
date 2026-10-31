import Link from "next/link";
import { ChevronLeft, ClipboardCheck } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { SkillsSurveyForm } from "@/components/coaching/skills-survey/skills-survey-form";
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

// One team member's survey in the admin shell, read only — the District Managers rate in the portal.

type PageProps = {
  params: Promise<{ hrId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const listHref = "/coaching/skills-survey";

function preservedQuery(params: Record<string, string | string[] | undefined>) {
  const value = Array.isArray(params.quarter) ? params.quarter[0] : params.quarter;
  return value?.trim() ? `?${new URLSearchParams({ quarter: value }).toString()}` : "";
}

export default async function CoachingSkillsSurveyMemberAdminPage({ params, searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  const { hrId: rawHrId } = await params;
  const hrId = decodeURIComponent(rawHrId);
  const query = await searchParams;
  const quarterParam = Array.isArray(query.quarter) ? query.quarter[0] : query.quarter;
  // The admin layout forwards a portal viewer before this runs (src/lib/navigation/portal-twins.ts);
  // this line is the page's own declaration of that twin.
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/coaching-skills-survey/${encodeURIComponent(hrId)}${preservedQuery(query)}`);
  }
  if (!canOpenSkillsSurvey(access) || !(await canAccess(access, "coaching_skills_survey", "read"))) {
    redirect("/admin/access");
  }

  let form: SkillsSurveyMemberForm;
  try {
    form = await getSkillsSurveyMemberForm(access, hrId, { quarter: parseSkillsSurveyQuarterKey(quarterParam) });
  } catch (error) {
    if (isForbiddenError(error) || error instanceof SkillsSurveyError) redirect(listHref);
    throw error;
  }

  return (
    <div className="space-y-6">
      <AdminPageHero
        description={`${form.member.name}${form.districtName ? ` · ${form.districtName}` : ""}`}
        eyebrow="Coaching"
        icon={<ClipboardCheck className="h-3.5 w-3.5" />}
        title={skillsSurveyTitle}
      />
      <Link className={phxButtonGhostClassName} href={listHref}>
        <ChevronLeft className="h-4 w-4" />
        Back to the survey
      </Link>
      <SkillsSurveyForm backHref={listHref} form={form} variant="admin" />
    </div>
  );
}
