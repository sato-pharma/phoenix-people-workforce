import { NextResponse } from "next/server";

import { listViewerTeamManagers } from "@/lib/recruitment/hiring-manager-team";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The managers beneath the caller, with how many CVs sit with each — the picker's whole data.
 *
 * The owner asked for a National Sales Manager to be able to choose one of his district managers and
 * read the CVs sitting with them. This is the "choose" half, and it takes NO input at all: the team
 * is derived from the caller's own session, so there is nothing here to guess or tamper with.
 *
 * An empty list is the correct answer for anybody who manages nobody, which is most callers holding
 * this permission. The screen renders that as "no team", never as an error.
 */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "read");
    const managers = await listViewerTeamManagers(access);
    return NextResponse.json({ managers, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the managers reporting to you.");
  }
}
