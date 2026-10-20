import { NextResponse } from "next/server";
import { assertApplicationVisible } from "@/lib/recruitment/workspace/fence";

import { setApplicationSourceAttribution } from "@/lib/recruitment/applications";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tag (or clear) which advert this application's candidate actually came from.
//
// Separate from the hire so the source can be attributed at any time — most hires arrive with no
// tracked code (a forwarded WhatsApp CV drops the applicant's own message, the only place the code
// lives), and HR usually knows the real source only later. Gated on recruitment:update, the same
// HR-authority set that manages the pipeline; the code is validated against the channel directory
// inside the service, so a typo is refused rather than stored.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's application answers as if absent.
    await assertApplicationVisible(access, id);
    const body = await readJsonObject(request);
    const application = await setApplicationSourceAttribution(id, access, {
      channelCode: str(body.channelCode),
    });
    return NextResponse.json({ success: true, application });
  } catch (error) {
    return recruitmentApiError(error, "Failed to tag the source of this hire.");
  }
}
