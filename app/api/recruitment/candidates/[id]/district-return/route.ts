import { NextResponse } from "next/server";

import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import { isCandidateInViewerDistrictScope } from "@/lib/recruitment/district-manager-folders-db";
import { deleteManagerSend } from "@/lib/recruitment/manager-sends";
import { isDistrictReturnReasonCode, recordDistrictReturn } from "@/lib/recruitment/district-returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Long enough for a real explanation, short enough that the admin queue stays readable. */
const REASON_NOTE_MAX_LENGTH = 500;

function validationError(message: string) {
  return NextResponse.json({ error: "validation", message, success: false }, { status: 400 });
}

/**
 * "Hand this CV back to the administrator." A district manager presses Return on a CV that reached
 * his folder by area or by governorate backfill; it leaves HIS folder and lands in the admin queue.
 *
 * TWO GATES, AND THE SECOND IS THE REAL ONE. `hiring_interviews: update` is the grant every district
 * manager already holds to work his folder — but a grant is company-wide, and a return must only be
 * possible on a CV that is actually his. `isCandidateInViewerDistrictScope` is that boundary: it
 * re-runs the very placement that put the CV in front of him, against his own seats, so a manager
 * cannot return a CV that was never in his district however he crafts the request. The scope check is
 * deliberately blind to returns he has already made, so a second press is the honest "already
 * returned" rather than a 403.
 *
 * manager_hr_id is taken from the SESSION, never the body — the person who pressed Return is the
 * person whose folder it leaves. The seat/area context in the body is display-only snapshot for the
 * admin queue and is not trusted for anything.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "update");
    const { id } = await params;
    if (!id) return validationError("A candidate id is required.");

    if (!access.hrId) {
      return NextResponse.json(
        { error: "forbidden", message: "Your session has no HR id, so a return cannot be attributed.", success: false },
        { status: 403 },
      );
    }

    const inScope = await isCandidateInViewerDistrictScope(access.hrId, id);
    if (!inScope) {
      return NextResponse.json(
        { error: "forbidden", message: "This CV is not in one of your areas, so you cannot return it.", success: false },
        { status: 403 },
      );
    }

    const body = await readJsonObject(request);
    const reasonCode = str(body.reasonCode);
    if (!isDistrictReturnReasonCode(reasonCode)) {
      return validationError('A reason is required. Use "area_not_match" or "other".');
    }
    const reasonNote = str(body.reasonNote);
    if (reasonCode === "other" && !reasonNote) {
      return validationError("Tell the administrator why you are returning this CV.");
    }
    if (reasonNote && reasonNote.length > REASON_NOTE_MAX_LENGTH) {
      return validationError(`Keep the reason under ${REASON_NOTE_MAX_LENGTH} characters.`);
    }

    const { recorded } = await recordDistrictReturn({
      candidateId: id,
      managerHrId: access.hrId,
      seatId: str(body.seatId),
      seatLabel: str(body.seatLabel),
      lineName: str(body.lineName),
      regionName: str(body.regionName),
      areaName: str(body.areaName),
      reasonCode,
      reasonNote,
    });

    // The folder is its sends (manager-cv-folders.ts), so handing the CV back leaves it by deleting
    // HIS send row — nobody else's. A re-push by Talent Acquisition writes a fresh row and puts it
    // back in front of him.
    await deleteManagerSend(id, access.hrId);

    // `recorded: false` means the CV was already returned — an honest 200, not an error.
    return NextResponse.json({ success: true, recorded });
  } catch (error) {
    return recruitmentApiError(error, "Failed to return this CV.");
  }
}
