import { NextResponse } from "next/server";

import {
  redactCandidateListContact,
  redactDistrictBoardsContact,
} from "@/lib/recruitment/candidate-call-claims";
import { loadCallClaims } from "@/lib/recruitment/candidate-call-claims-db";
import { loadCandidateOpeners } from "@/lib/recruitment/candidate-openers-db";
import { districtBoardCandidateIds } from "@/lib/recruitment/district-manager-folders-db";
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

    // ── THE PHONE NUMBERS COME OUT HERE, AND THEY ALWAYS COME OUT ────────────────────────────────
    //
    // This is the one list where the redaction is unconditional rather than claim-dependent. The
    // caller is a manager reading what sits with the managers BELOW him, and he may not reserve any
    // of it (the owner's 2026-08-30 rule that the answer belongs to the manager the CV was sent to),
    // so he can never be the holder — `redactCandidateListContact` reaches the same conclusion on
    // its own, and it is asked rather than short-circuited so there is one redactor and not two.
    //
    // The claims still travel: he needs to SEE that a CV is taken and by whom. That is the whole
    // point of the reservation on this screen.
    const cardCandidateIds = [
      ...candidates.map((candidate) => candidate.id),
      ...districtBoardCandidateIds(districtBoards),
    ];
    const callClaims = await loadCallClaims(cardCandidateIds);
    // Who ELSE has opened each of these CVs — name, title, Cairo time — for the "already opened by"
    // banner (owner, 2026-09-20). The CALLER is left out of it, so an NSM reading his managers' CVs
    // is told about the managers and colleagues who read them, never about himself.
    const openers = await loadCandidateOpeners(cardCandidateIds, access.hrId);

    return NextResponse.json({
      callClaims,
      candidates: redactCandidateListContact(candidates, callClaims, access.hrId),
      districtBoards: redactDistrictBoardsContact(districtBoards, callClaims, access.hrId),
      files,
      manager,
      openers,
      success: true,
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load that manager's candidates.");
  }
}
