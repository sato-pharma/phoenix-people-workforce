import { NextResponse } from "next/server";

import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import { resolveDistrictReturn } from "@/lib/recruitment/district-returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOTE_MAX_LENGTH = 500;

/**
 * "I have dealt with this returned CV." The administrator clears one row from the Returned CVs queue.
 *
 * Gated on `recruitment: update` — the recruiting-admin grant a district manager does NOT hold, so
 * the person clearing the queue is never the person who filled it. The row leaves the queue but the
 * CV stays suppressed from the returning manager's folder (see district-returns.ts): resolving is the
 * admin acknowledging the return, not overturning it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "validation", message: "A return id is required.", success: false }, { status: 400 });
    }

    const body = await readJsonObject(request);
    const note = str(body.note);
    if (note && note.length > NOTE_MAX_LENGTH) {
      return NextResponse.json(
        { error: "validation", message: `Keep the note under ${NOTE_MAX_LENGTH} characters.`, success: false },
        { status: 400 },
      );
    }

    await resolveDistrictReturn({ returnId: id, resolvedByHrId: access.hrId, resolutionNote: note });
    return NextResponse.json({ success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to resolve this returned CV.");
  }
}
