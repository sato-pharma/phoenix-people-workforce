// Recruitment / ATS — the "sorry" message: telling a rejected applicant on WhatsApp, kindly, that the
// company will not move forward (owner, 2026-10-20).
//
// A SEPARATE STEP FROM THE REJECTION, on purpose. Rejecting a candidate in the workspace has a
// ten-second Undo; a WhatsApp message cannot be taken back. So the message is offered only once the
// rejection stands, by its own press, and never sent automatically.
//
// SENT ONLY WHEN IT CAN BE RIGHT:
//   * the candidate is rejected;
//   * they wrote to us on WhatsApp themselves (the number their CV came from, on the line it came
//     to) — an emailed CV has no chat to answer;
//   * that number is the applicant's own: a number that sent CVs for several people is a forwarder's,
//     and the message would reach the wrong person;
//   * WhatsApp's 24-hour window is open — measured from the later of their CV and their last message
//     in the Inbox. After that only an approved template may be sent, and this is not one;
//   * it has not been sent to them already.
//
// The words are HR's to edit on the Screening Questions screen (`rejection_message_text`), with a
// default below in recruitment-settings-db.ts.

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { recruitmentDb } from "@/lib/recruitment/db";
import { resolveCandidateReplyTarget, replyWindow } from "@/lib/recruitment/inbound/whatsapp-conversation";
import { sendWhatsAppText } from "@/lib/recruitment/inbound/whatsapp-interactive";
import { rejectionMessageText } from "@/lib/recruitment/recruitment-settings-db";

export const REJECTION_MESSAGE_EVENT = "recruitment_rejection_message_send";
export const WINDOW_CLOSED_REASON = "The 24-hour WhatsApp window has closed";

/**
 * True when this number sent CVs that became somebody OTHER than this candidate — a forwarder's
 * number (two forwarders carry most WhatsApp CVs). Throws on a failed read.
 */
export async function isForwarderNumber(waId: string, candidateId: string): Promise<boolean> {
  const { data, error } = await recruitmentDb()
    .from("ats_cv_intake_events")
    .select("candidate_id")
    .eq("sender_identifier", `+${waId}`)
    .not("candidate_id", "is", null)
    .neq("candidate_id", candidateId)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** The applicant's last message in the WhatsApp Inbox on this line, or null. */
async function inboxLastInboundAt(phoneNumberId: string, waId: string): Promise<string | null> {
  const { data } = await recruitmentDb()
    .from("whatsapp_inbox_conversations")
    .select("last_inbound_at")
    .eq("phone_number_id", phoneNumberId)
    .eq("contact_key", waId)
    .maybeSingle();
  return (data as { last_inbound_at: string | null } | null)?.last_inbound_at ?? null;
}

/** Whether the message already went to this number. */
async function alreadySent(waId: string): Promise<boolean> {
  const { data, error } = await recruitmentDb()
    .from("ats_whatsapp_outbound_messages")
    .select("id")
    .eq("event", REJECTION_MESSAGE_EVENT)
    .eq("ok", true)
    .eq("to_wa_id", waId)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

type Resolved =
  | { ok: true; text: string; toWaId: string; phoneNumberId: string }
  | { ok: false; reason: string; text: string | null };

async function resolveRejectionMessage(candidateId: string, now: Date): Promise<Resolved> {
  const text = await rejectionMessageText();
  const { data, error } = await recruitmentDb().from("ats_candidates").select("id,status").eq("id", candidateId).maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, reason: "Candidate not found.", text: null };
  if ((data as { status: string | null }).status !== "rejected") {
    return { ok: false, reason: "The message is for a rejected candidate. Reject them first.", text };
  }

  const target = await resolveCandidateReplyTarget(candidateId, now);
  if (!target) return { ok: false, reason: "They never wrote to us on WhatsApp, so there is no chat to answer.", text };
  if (await isForwarderNumber(target.toWaId, candidateId)) {
    return { ok: false, reason: "Their CV came from a number that sent CVs for several people, so the message would reach the wrong person.", text };
  }

  // The window is the LATER of the CV and their last message in the Inbox.
  let open = target.windowOpen;
  if (!open) {
    const lastInbound = await inboxLastInboundAt(target.phoneNumberId, target.toWaId);
    const at = lastInbound ? new Date(lastInbound) : null;
    open = Boolean(at && !Number.isNaN(at.getTime()) && replyWindow(at, now).open);
  }
  if (!open) return { ok: false, reason: WINDOW_CLOSED_REASON, text };
  if (await alreadySent(target.toWaId)) return { ok: false, reason: "The message was already sent to them.", text };
  return { ok: true, phoneNumberId: target.phoneNumberId, text, toWaId: target.toWaId };
}

/** Whether the message can be sent now, why not, and the words it would send. */
export async function rejectionMessageAvailability(
  candidateId: string,
): Promise<{ canSend: boolean; reason: string | null; text: string | null }> {
  const resolved = await resolveRejectionMessage(candidateId, new Date());
  return resolved.ok
    ? { canSend: true, reason: null, text: resolved.text }
    : { canSend: false, reason: resolved.reason, text: resolved.text };
}

/** Sends the message. `{ sent: false, reason }` for every refusal; throws on a failed audit row. */
export async function sendRejectionMessage(
  candidateId: string,
  actor: { hrId: string; name?: string | null },
): Promise<{ sent: boolean; reason: string | null }> {
  const resolved = await resolveRejectionMessage(candidateId, new Date());
  if (!resolved.ok) return { reason: resolved.reason, sent: false };

  const result = await sendWhatsAppText({
    event: REJECTION_MESSAGE_EVENT,
    logContext: { detail: { candidateId, sentByHrId: actor.hrId, source: "recruitment_workspace" } },
    phoneNumberId: resolved.phoneNumberId,
    text: resolved.text,
    toWaId: resolved.toWaId,
  });
  if (!result.ok) {
    return { reason: result.reason === "window_closed" ? WINDOW_CLOSED_REASON : "WhatsApp did not accept the message. Try again later.", sent: false };
  }

  await writeRequiredAuditLog({
    actorLoginId: actor.hrId,
    entityId: candidateId,
    entityType: "whatsapp_inbox_message",
    newValues: { event: REJECTION_MESSAGE_EVENT, text: resolved.text, wamid: result.wamid },
    summary: "Recruitment: sent a rejected applicant the closing message on WhatsApp",
  });
  return { reason: null, sent: true };
}
