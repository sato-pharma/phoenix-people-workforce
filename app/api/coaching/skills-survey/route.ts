import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { parseSkillsSurveyQuarterKey } from "@/lib/coaching/skills-survey/calculations";
import { getSkillsSurveyWorkspace, saveSkillsSurvey, SkillsSurveyError } from "@/lib/coaching/skills-survey/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Team Coaching Skills Survey (owner, 2026-10-31). GET: the chosen quarter's surveys this viewer
// may read, and a District Manager's own team. POST: the District Manager saves one team member's
// survey for the current quarter. The person rated is never told — no email, bell or Telegram.

function failure(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.", { report: false }) }, { status: 403 });
  }
  if (error instanceof SkillsSurveyError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return NextResponse.json({ error: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "coaching_skills_survey", "read");
    const quarter = parseSkillsSurveyQuarterKey(new URL(request.url).searchParams.get("quarter"));
    const workspace = await getSkillsSurveyWorkspace(access, { quarter });
    return NextResponse.json({ data: workspace }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error, "The survey could not be read.");
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "coaching_skills_survey", "create");
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "The survey could not be read. Please try again." }, { status: 400 });
    }
    if (!body || typeof body !== "object" || typeof body.memberHrId !== "string" || !body.memberHrId.trim()) {
      return NextResponse.json({ error: "Choose a team member." }, { status: 400 });
    }
    const survey = await saveSkillsSurvey(access, {
      developmentPriorities: body.developmentPriorities,
      memberHrId: body.memberHrId.trim(),
      quarter: typeof body.quarter === "number" ? body.quarter : null,
      scores: body.scores,
      totalExperienceYears: body.totalExperienceYears,
      year: typeof body.year === "number" ? body.year : null,
    });
    return NextResponse.json({ data: survey, message: "Survey saved." });
  } catch (error) {
    return failure(error, "The survey could not be saved.");
  }
}
