import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  getSkillsSurveyConfig,
  saveSkillsSurveySettings,
  SkillsSurveyError,
  type SkillsSurveySettingsInput,
} from "@/lib/coaching/skills-survey/service";
import { canOpenSkillsSurvey } from "@/lib/coaching/skills-survey/access";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Team Coaching Skills Survey's settings and skills list — the workbook's Ranking and Analysis
// settings and its Skills sheet. Everyone who opens the survey reads them; only the Training Manager
// and the Super Admin change them (checked again inside saveSkillsSurveySettings).

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
    if (!canOpenSkillsSurvey(access)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const config = await getSkillsSurveyConfig();
    return NextResponse.json({ data: config }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error, "The survey settings could not be read.");
  }
}

export async function PUT(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "coaching_skills_survey", "update");
    let body: SkillsSurveySettingsInput;
    try {
      body = (await request.json()) as SkillsSurveySettingsInput;
    } catch {
      return NextResponse.json({ error: "The settings could not be read. Please try again." }, { status: 400 });
    }
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
    }
    const config = await saveSkillsSurveySettings(access, { settings: body.settings, skills: body.skills });
    return NextResponse.json({ data: config, message: "Settings saved." });
  } catch (error) {
    return failure(error, "The survey settings could not be saved.");
  }
}
