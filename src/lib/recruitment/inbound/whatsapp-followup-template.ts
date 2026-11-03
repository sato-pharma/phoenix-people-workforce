// Recruitment / ATS — "Ask again": HR asks an applicant, on WhatsApp, to come back and answer the
// questions they left blank (owner, 2026-10-20).
//
// WHY A TEMPLATE. WhatsApp lets a business write freely only within 24 hours of the person's last
// message; most applicants with missing answers went quiet days ago. The one message allowed outside
// that window is a template Meta has approved, so "Ask again" sends `phx_application_followup` —
// "Hello {{name}}, thank you for applying to Sato Pharma. A few questions about your application are
// still unanswered. Reply to this message to continue." — from the recruitment line. Their reply
// opens the window, and the bot picks the conversation up where their answers stop (`resumeClassification`
// in whatsapp-classify-session.ts). Until Meta approves it the button says "Waiting for Meta approval"
// and sends nothing; scripts/recruitment/submit-followup-template.ts submits it.
//
// REFUSED, with a sentence HR reads, when: there is no number WhatsApp can reach; the only number is a
// forwarder's (it sent CVs for several people — the message would go to the wrong person); the
// person is hired, rejected or archived; they were asked in the last 24 hours; or nothing is missing
// and they are already filed.
//
// Sent through the WhatsApp Inbox's own `startInboxConversation`, so the message is recorded, shows in
// the Inbox, and the chat is linked to the candidate when it was not linked to anyone.

import type { AccessContext } from "@/lib/auth/permissions";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { logError } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import { isForwarderNumber } from "@/lib/recruitment/inbound/whatsapp-rejection-message";
import {
  askAgainRefusal,
  FOLLOWUP_BULK_MAX,
  FOLLOWUP_TEMPLATE_LANGUAGE,
  FOLLOWUP_TEMPLATE_NAME,
  followupFirstName,
  followupStatusLabels,
  type FollowupCandidateRow,
} from "@/lib/recruitment/inbound/whatsapp-followup-template-rules";
import { recomputeCompleteness } from "@/lib/recruitment/workspace/completeness";
import { readTemplateStatus, type TemplateApprovalStatus } from "@/lib/whatsapp-inbox/graph";
import { whatsAppInboxLines } from "@/lib/whatsapp-inbox/lines";
import { isPhoneMatchLink } from "@/lib/whatsapp-inbox/phone-link";
import { normalizeNewChatNumber, startInboxConversation } from "@/lib/whatsapp-inbox/send";
import { linkInboxConversation } from "@/lib/whatsapp-inbox/store";

// The pure half (the template, who may be asked) is whatsapp-followup-template-rules.ts; re-exported
// so every caller keeps one import.
export {
  FOLLOWUP_BULK_MAX,
  FOLLOWUP_COOLDOWN_MS,
  FOLLOWUP_TEMPLATE_BODY,
  FOLLOWUP_TEMPLATE_LANGUAGE,
  FOLLOWUP_TEMPLATE_NAME,
  askAgainRefusal,
  followupFirstName,
  followupStatusLabels,
} from "@/lib/recruitment/inbound/whatsapp-followup-template-rules";
export type { FollowupCandidateRow } from "@/lib/recruitment/inbound/whatsapp-followup-template-rules";

const STATUS_CACHE_TTL_MS = 10 * 60_000;

/** The recruitment line — the number applicants wrote to, and the account that owns the template. */
function recruitmentLine() {
  return whatsAppInboxLines()[0];
}

let statusCache: { at: number; status: TemplateApprovalStatus } | null = null;

/** Test seam. */
export function resetFollowupStatusCache(): void {
  statusCache = null;
}

/** Where the follow-up template stands with Meta, cached ten minutes. A failed read is "pending". */
export async function followupTemplateStatus(): Promise<{ status: TemplateApprovalStatus; label: string }> {
  if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_TTL_MS) {
    return { label: followupStatusLabels[statusCache.status], status: statusCache.status };
  }
  let status: TemplateApprovalStatus;
  try {
    status = await readTemplateStatus(recruitmentLine().businessAccountId, FOLLOWUP_TEMPLATE_NAME, FOLLOWUP_TEMPLATE_LANGUAGE);
    statusCache = { at: Date.now(), status };
  } catch (error) {
    logError("The WhatsApp follow-up template's status could not be read", {
      error,
      labels: { event: "recruitment_followup_status_failed" },
    });
    status = "pending";
  }
  return { label: followupStatusLabels[status], status };
}

/** The number "Ask again" writes to: their own WhatsApp number on file, else their phone. Digits. */
function followupNumber(row: Pick<FollowupCandidateRow, "phone" | "whatsapp">): string | null {
  for (const raw of [row.whatsapp, row.phone]) {
    const waId = raw ? normalizeNewChatNumber(raw) : null;
    if (waId) return waId;
  }
  return null;
}

async function loadFollowupCandidate(candidateId: string): Promise<{ row: FollowupCandidateRow; placed: boolean } | null> {
  // Fresh numbers first: the refusal reads the stored completeness.
  await recomputeCompleteness([candidateId]);
  const db = recruitmentDb();
  const { data, error } = await db
    .from("ats_candidates")
    .select("id,full_name,phone,whatsapp,status,archived_at,followup_sent_at,missing_answer_keys")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { count, error: placedError } = await db
    .from("ats_candidate_placements")
    .select("id", { count: "exact", head: true })
    .eq("candidate_id", candidateId);
  if (placedError) throw placedError;
  return { placed: (count ?? 0) > 0, row: data as FollowupCandidateRow };
}

/**
 * Sends the follow-up to one candidate. `{ sent: false, reason }` for every refusal — a sentence HR
 * reads. Throws only on a failure HR should see as an error (the send itself, the audit row).
 */
export async function sendAskAgain(
  candidateId: string,
  access: AccessContext,
  options: { templateStatus?: TemplateApprovalStatus } = {},
): Promise<{ sent: boolean; reason: string | null }> {
  const status = options.templateStatus ?? (await followupTemplateStatus()).status;
  if (status !== "approved") return { reason: followupStatusLabels[status], sent: false };

  const loaded = await loadFollowupCandidate(candidateId);
  if (!loaded) return { reason: "Candidate not found.", sent: false };
  const { row, placed } = loaded;
  const waId = followupNumber(row);
  const forwarder = waId ? await isForwarderNumber(waId, candidateId) : false;
  const refusal = askAgainRefusal({ candidate: row, forwarder, nowMs: Date.now(), placed, waId });
  if (refusal || !waId) return { reason: refusal ?? "There is no mobile number on this candidate that WhatsApp can reach.", sent: false };

  const line = recruitmentLine();
  const result = await startInboxConversation({
    access,
    language: FOLLOWUP_TEMPLATE_LANGUAGE,
    phone: waId,
    phoneNumberId: line.phoneNumberId,
    templateName: FOLLOWUP_TEMPLATE_NAME,
    values: { "body:name": followupFirstName(row.full_name) },
  });

  // Stamped before anything else can fail, so a retry after an error is refused, never a second send.
  const hrId = access.hrId?.trim() || null;
  const sentAt = new Date().toISOString();
  const db = recruitmentDb();
  const { error: stampError } = await db
    .from("ats_candidates")
    .update({ followup_sent_at: sentAt, followup_sent_by: hrId ?? access.loginId ?? null })
    .eq("id", candidateId);
  if (stampError) throw stampError;

  // The chat is this candidate's from now on — unless someone already linked it to a person. A phone
  // match is not someone: replacing it with this link is what lets their reply find them.
  if (result.conversationId) {
    try {
      const { data: conversation } = await db
        .from("whatsapp_inbox_conversations")
        .select("candidate_id,employee_hr_id,linked_by_hr_id")
        .eq("id", result.conversationId)
        .maybeSingle();
      const linked = conversation as { candidate_id: string | null; employee_hr_id: string | null; linked_by_hr_id: string | null } | null;
      if (linked && !linked.employee_hr_id && (!linked.candidate_id || isPhoneMatchLink(linked.linked_by_hr_id))) {
        await linkInboxConversation({ access, candidateId, conversationId: result.conversationId, employeeHrId: null });
      }
    } catch (error) {
      logError("The follow-up chat could not be linked to its candidate", {
        error,
        labels: { event: "recruitment_followup_link_failed" },
      });
    }
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? hrId,
    entityId: candidateId,
    entityType: "whatsapp_inbox_message",
    newValues: { conversationId: result.conversationId, template: FOLLOWUP_TEMPLATE_NAME, wamid: result.wamid },
    summary: "Recruitment: asked an applicant on WhatsApp to finish their unanswered questions",
  });
  return { reason: null, sent: true };
}

/** "Ask again" for several at once: one after another, at most 50, every refusal named. */
export async function sendAskAgainMany(
  candidateIds: readonly string[],
  access: AccessContext,
): Promise<{ sent: number; skipped: { candidateId: string; reason: string }[] }> {
  const unique = Array.from(new Set(candidateIds.filter((id) => typeof id === "string" && id.trim())));
  const ids = unique.slice(0, FOLLOWUP_BULK_MAX);
  const skipped: { candidateId: string; reason: string }[] = unique
    .slice(FOLLOWUP_BULK_MAX)
    .map((candidateId) => ({ candidateId, reason: `Only ${FOLLOWUP_BULK_MAX} are asked at a time; press again for the rest.` }));
  const { status } = await followupTemplateStatus();
  let sent = 0;
  for (const candidateId of ids) {
    try {
      const result = await sendAskAgain(candidateId, access, { templateStatus: status });
      if (result.sent) sent += 1;
      else skipped.push({ candidateId, reason: result.reason ?? "Not sent." });
    } catch (error) {
      skipped.push({ candidateId, reason: error instanceof Error ? error.message : "Not sent." });
    }
  }
  return { sent, skipped };
}
