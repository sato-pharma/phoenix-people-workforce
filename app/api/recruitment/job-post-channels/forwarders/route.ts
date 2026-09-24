import { NextResponse } from "next/server";

import { assignForwarderToChannel, listJobPostChannels } from "@/lib/recruitment/outreach/job-post-channels";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tie one relay handset to one advert channel, or clear it.
 *
 * A relay maps to exactly one channel, so the service strips the number from every other channel
 * before attaching it here. `channelCode: null` (or omitted) leaves the relay unassigned — a
 * code-less forward from it then resolves to "we do not know", the same as any direct applicant.
 */
export async function PUT(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    await requireRecruitmentAccess(request, "recruitment", "update");
    const body = await readJsonObject(request);

    const identifier = str(body.identifier);
    if (!identifier) {
      return NextResponse.json(
        { error: "validation", message: "A relay handset number is required.", success: false },
        { status: 400 },
      );
    }

    // A missing key and an explicit null both mean "unassign"; only a non-empty string assigns.
    const channelCode = body.channelCode === null || body.channelCode === undefined ? null : str(body.channelCode);

    await assignForwarderToChannel(identifier, channelCode);
    const channels = await listJobPostChannels({ includeInactive: true });
    return NextResponse.json({ channels, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to update the relay handset.");
  }
}
