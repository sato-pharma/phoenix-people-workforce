import { NextResponse } from "next/server";

import { inboxApiError, inboxForbidden } from "@/app/api/whatsapp-inbox/_lib/inbox-http";
import { requireRecruitmentAccess, str } from "@/app/api/recruitment/_lib/http";
import { findInboxPeople } from "@/lib/whatsapp-inbox/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Candidates and employees a chat might belong to: phone matches first, then a name search. Super Admin only. */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const forbidden = inboxForbidden(access);
    if (forbidden) return forbidden;
    const url = new URL(request.url);
    const people = await findInboxPeople({
      conversationId: str(url.searchParams.get("conversationId")),
      search: url.searchParams.get("q"),
    });
    return NextResponse.json({ people });
  } catch (error) {
    return inboxApiError(error, "Failed to look up people.");
  }
}
