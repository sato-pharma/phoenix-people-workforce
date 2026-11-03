import { NextResponse } from "next/server";

import { inboxActor, inboxApiError, inboxForbidden } from "@/app/api/whatsapp-inbox/_lib/inbox-http";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentProblem,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";
import { assertInboxConversationVisibleTo, linkInboxConversation } from "@/lib/whatsapp-inbox/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A person links a chat to a candidate or an employee, or clears the link. Their decision stands: the
 * automatic phone match (`linkInboxChatsByPhone`) never touches a chat a person has decided. Super Admin only.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const forbidden = inboxForbidden(access);
    if (forbidden) return forbidden;
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): a chat with an HR applicant answers as if absent.
    await assertInboxConversationVisibleTo(access, id);

    const body = await readJsonObject(request);
    const candidateId = str(body.candidateId);
    const employeeHrId = str(body.employeeHrId);
    if (candidateId && employeeHrId) return recruitmentProblem("Link the chat to a candidate or an employee, not both.", 400);
    // Nor can a chat be tied to an HR applicant from her seat.
    if (candidateId) await assertCandidateVisible(access, candidateId);

    const result = await linkInboxConversation({ access, candidateId, conversationId: id, employeeHrId });
    await writeRequiredAuditLog({
      actorLoginId: inboxActor(access),
      entityId: id,
      entityType: "whatsapp_inbox_conversation",
      newValues: result.after,
      oldValues: result.before,
      summary: candidateId || employeeHrId ? "Linked a WhatsApp chat to a person." : "Removed a WhatsApp chat's link to a person.",
    });
    return NextResponse.json({ success: true, ...result.after });
  } catch (error) {
    return inboxApiError(error, "Failed to link the chat.");
  }
}
