import { NextResponse } from "next/server";

import { inboxApiError, inboxForbidden } from "@/app/api/whatsapp-inbox/_lib/inbox-http";
import { requireRecruitmentAccess, str } from "@/app/api/recruitment/_lib/http";
import { fenceCandidateIds } from "@/lib/recruitment/workspace/fence";
import { assertInboxConversationVisibleTo, findInboxPeople } from "@/lib/whatsapp-inbox/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Candidates and employees a chat might belong to: phone matches first, then a name search. Super Admin only. */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const forbidden = inboxForbidden(access);
    if (forbidden) return forbidden;
    const url = new URL(request.url);
    const conversationId = str(url.searchParams.get("conversationId"));
    // The Talent Acquisition fence (owner, 2026-10-20): not for an HR applicant's chat, and never
    // offering an HR applicant as the person a chat belongs to.
    if (conversationId) await assertInboxConversationVisibleTo(access, conversationId);
    const found = await findInboxPeople({ conversationId, search: url.searchParams.get("q") });
    const visible = await fenceCandidateIds(
      access,
      found.filter((person) => person.kind === "candidate").map((person) => person.id),
    );
    const people = found.filter((person) => person.kind !== "candidate" || visible.has(person.id));
    return NextResponse.json({ people });
  } catch (error) {
    return inboxApiError(error, "Failed to look up people.");
  }
}
