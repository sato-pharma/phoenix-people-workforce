import { ClipboardCheck } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { SkillsSurveyWorkspace } from "@/components/coaching/skills-survey/skills-survey-workspace";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canOpenSkillsSurvey } from "@/lib/coaching/skills-survey/access";
import { parseSkillsSurveyQuarterKey } from "@/lib/coaching/skills-survey/calculations";
import { getSkillsSurveyWorkspace } from "@/lib/coaching/skills-survey/service";
import { parseSkillsSurveyTab, skillsSurveyInstructions, skillsSurveyTitle } from "@/lib/coaching/skills-survey/vocabulary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Team Coaching Skills Survey in the admin shell — the CEO, the SFE Manager and the Super Admin
// read the whole company here. The District Managers rate in the employee portal.

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function preservedQuery(params: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const key of ["quarter", "tab"]) {
    const value = first(params[key]);
    if (value?.trim()) query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export default async function CoachingSkillsSurveyAdminPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  const params = await searchParams;
  // The admin layout forwards a portal viewer before this runs (src/lib/navigation/portal-twins.ts);
  // this line is the page's own declaration of that twin.
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/coaching-skills-survey${preservedQuery(params)}`);
  }
  if (!canOpenSkillsSurvey(access) || !(await canAccess(access, "coaching_skills_survey", "read"))) {
    redirect("/admin/access");
  }

  const data = await getSkillsSurveyWorkspace(access, { quarter: parseSkillsSurveyQuarterKey(first(params.quarter)) });

  return (
    <div className="space-y-6">
      <AdminPageHero
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>Field Coaching</AdminInsightChip>
            <AdminInsightChip tone="slate">Managers only</AdminInsightChip>
          </div>
        }
        description={skillsSurveyInstructions.lead}
        eyebrow="Coaching"
        icon={<ClipboardCheck className="h-3.5 w-3.5" />}
        title={skillsSurveyTitle}
      />
      <SkillsSurveyWorkspace
        data={data}
        initialTab={parseSkillsSurveyTab(first(params.tab))}
        memberHrefBase="/coaching/skills-survey"
      />
    </div>
  );
}
