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
import { assertInboxMessageVisibleTo, saveInboxAttachmentToCandidate } from "@/lib/whatsapp-inbox/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Copies a chat attachment into a candidate's files, as their CV or another document. Super Admin only. */
export async function POST(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const forbidden = inboxForbidden(access);
    if (forbidden) return forbidden;
    const { messageId } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): neither the message nor the person may be an HR applicant's.
    await assertInboxMessageVisibleTo(access, messageId);

    const body = await readJsonObject(request);
    const candidateId = str(body.candidateId);
    if (!candidateId) return recruitmentProblem("Pick the candidate to save this to.", 400);
    await assertCandidateVisible(access, candidateId);
    const kind = str(body.kind) === "other" ? "other" : "cv";

    const saved = await saveInboxAttachmentToCandidate({ access, candidateId, kind, messageId });
    await writeRequiredAuditLog({
      actorLoginId: inboxActor(access),
      entityId: messageId,
      entityType: "whatsapp_inbox_message",
      newValues: { candidateId, fileId: saved.fileId, fileName: saved.fileName, kind },
      oldValues: saved.previousCandidateId ? { candidateId: saved.previousCandidateId } : null,
      summary: `Saved a WhatsApp attachment to ${saved.candidateName}'s files from the WhatsApp Inbox.`,
    });
    return NextResponse.json({ success: true, ...saved }, { status: 201 });
  } catch (error) {
    return inboxApiError(error, "Failed to save the attachment.");
  }
}
