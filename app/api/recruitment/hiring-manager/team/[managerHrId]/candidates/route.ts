import { NextResponse } from "next/server";

import { listTeamManagerCandidates } from "@/lib/recruitment/hiring-manager-team";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The CVs pushed to one manager beneath the caller.
 *
 * THIS IS THE FIRST ROUTE IN THIS FOLDER THAT TAKES AN HR_ID FROM THE CALLER. Every sibling reads
 * the caller's own id off the session and says so in its header — *"there is no id to guess and no
 * way to ask for somebody else's pushes."* That property is what the owner's request necessarily
 * gives up, so the id is proven against the org chart inside listTeamManagerCandidates before a
 * single candidate row is read.
 *
 * An id outside the caller's team is a 403, never an empty list. Answering "no candidates" would let
 * anyone holding this permission map the whole company by asking about HR_IDs one at a time and
 * watching which ones answer differently.
 */
export async function GET(request: Request, { params }: { params: Promise<{ managerHrId: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "read");
    const { managerHrId } = await params;
    // `files` rides along with the list on purpose — the CV control has to be there when the card
    // is, and asking per card put it fifteen seconds behind. See listTeamManagerCandidates.
    const { candidates, districtBoards, files, manager } = await listTeamManagerCandidates(
      access,
      decodeURIComponent(managerHrId),
    );
    // `districtBoards` is that manager's own areas from the organogram, each holding the applicants
    // who asked for it — the owner, 2026-08-31: "when he choose his district manager, he can see
    // their folders and the CV in per folder." It comes back from the SAME call as the candidates
    // deliberately: one gate, passed once, rather than a second route with a second copy of it.
    return NextResponse.json({ candidates, districtBoards, files, manager, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load that manager's candidates.");
  }
}
