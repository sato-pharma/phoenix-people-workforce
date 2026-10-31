import { redirect } from "next/navigation";

import { SkillsSurveyWorkspace } from "@/components/coaching/skills-survey/skills-survey-workspace";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canOpenSkillsSurvey } from "@/lib/coaching/skills-survey/access";
import { parseSkillsSurveyQuarterKey } from "@/lib/coaching/skills-survey/calculations";
import { getSkillsSurveyWorkspace } from "@/lib/coaching/skills-survey/service";
import { parseSkillsSurveyTab, skillsSurveyInstructions, skillsSurveyTitle } from "@/lib/coaching/skills-survey/vocabulary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Team Coaching Skills Survey in the employee portal (owner, 2026-10-31): the District Manager
// rates his team here; the Regional Manager, the National Sales Manager and the Training Manager read
// it. Never a Medical Rep — the person rated never sees this survey.

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CoachingSkillsSurveyPortalPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (resolveNavigationMode(access) !== "employee-portal") redirect("/coaching/skills-survey");

  if (!canOpenSkillsSurvey(access) || !(await canAccess(access, "coaching_skills_survey", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="This survey is for managers and the Training Manager."
        title="Survey unavailable"
      />
    );
  }

  const params = await searchParams;
  const data = await getSkillsSurveyWorkspace(access, { quarter: parseSkillsSurveyQuarterKey(first(params.quarter)) });

  return (
    <EmployeePortalPageShell
      badge="Field Coaching"
      description={skillsSurveyInstructions.lead}
      errorBoundaryTitle="The survey is unavailable"
      title={skillsSurveyTitle}
    >
      <SkillsSurveyWorkspace
        data={data}
        initialTab={parseSkillsSurveyTab(first(params.tab))}
        memberHrefBase="/employee-portals/coaching-skills-survey"
      />
    </EmployeePortalPageShell>
  );
}
