// The WhatsApp Inbox — sending from Phoenix: a typed reply, a photo or file, or an approved template.
//
// Every send goes through `sendWhatsAppPayload`, so it lands in the recruitment outbound log AND in
// the inbox thread without this file writing either. What this file owns is the refusals that happen
// BEFORE Meta is asked, each in a sentence the Super Admin can act on:
//
//   free text or a file outside the 24-hour window  → refused here; Meta would refuse it with 131047.
//   a username-only contact                          → refused; WhatsApp gives Phoenix no number to send to.
//   a template the line's own account does not hold → impossible by construction: the template is
//                                                      looked up in THAT line's account at send time.

import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdForStorage } from "@/lib/hr-id";
import { normalizePhone } from "@/lib/recruitment/candidate-matching";
import { sendWhatsAppPayload, type WhatsAppSendResult } from "@/lib/recruitment/inbound/whatsapp-interactive";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  buildTemplateMessage,
  listApprovedTemplates,
  mediaLimitProblem,
  missingTemplateFields,
  outboundMediaTypeFor,
  renderInboxTemplate,
  uploadWhatsAppMedia,
  type InboxTemplate,
} from "@/lib/whatsapp-inbox/graph";
import { findWhatsAppInboxLine, type WhatsAppInboxLine } from "@/lib/whatsapp-inbox/lines";
import { WHATSAPP_INBOX_CONVERSATIONS_TABLE, type InboxSendDetail } from "@/lib/whatsapp-inbox/record";
import {
  isReplyWindowOpen,
  loadInboxConversationForSend,
  storeInboxOutboundFile,
  WhatsAppInboxInputError,
} from "@/lib/whatsapp-inbox/store";

export const INBOX_TEXT_MAX_LENGTH = 4096;
export const INBOX_CAPTION_MAX_LENGTH = 1024;

export const WINDOW_CLOSED_MESSAGE =
  "More than 24 hours have passed since this person last wrote, so WhatsApp only allows an approved template now.";

export class WhatsAppInboxSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WhatsAppInboxSendError";
  }
}

/** A refused send, in a sentence. Exported for the test. */
export function sendFailureMessage(result: Extract<WhatsAppSendResult, { ok: false }>): { message: string; status: number } {
  if (result.reason === "window_closed") return { message: WINDOW_CLOSED_MESSAGE, status: 409 };
  if (result.reason === "disabled") return { message: "WhatsApp is not connected on this server.", status: 503 };
  return { message: `WhatsApp did not send the message${result.detail ? `: ${result.detail}` : "."}`, status: 502 };
}

function actorHrId(access: AccessContext): string | null {
  return hrIdForStorage(access.hrId) ?? access.loginId ?? null;
}

async function sendable(conversationId: string) {
  const conversation = await loadInboxConversationForSend(conversationId);
  if (conversation.problem || !conversation.contactWaId || !conversation.line) {
    throw new WhatsAppInboxSendError(conversation.problem ?? "This chat cannot be answered from Phoenix.", 409);
  }
  return { ...conversation, contactWaId: conversation.contactWaId, line: conversation.line };
}

function finish(result: WhatsAppSendResult): { wamid: string | null } {
  if (result.ok) return { wamid: result.wamid };
  const failure = sendFailureMessage(result);
  throw new WhatsAppInboxSendError(failure.message, failure.status);
}

function logContext(access: AccessContext, conversationId: string, inbox: InboxSendDetail) {
  return { detail: { conversationId, inbox: { ...inbox, sentByHrId: actorHrId(access) }, source: "whatsapp_inbox" } };
}

export async function sendInboxText(input: { access: AccessContext; conversationId: string; text: string; replyToWamid?: string | null }) {
  const text = input.text.trim();
  if (!text) throw new WhatsAppInboxInputError("Type a message first.");
  if (text.length > INBOX_TEXT_MAX_LENGTH) throw new WhatsAppInboxInputError(`A WhatsApp message can be at most ${INBOX_TEXT_MAX_LENGTH} characters.`);
  const conversation = await sendable(input.conversationId);
  if (!isReplyWindowOpen(conversation.lastInboundAt)) throw new WhatsAppInboxSendError(WINDOW_CLOSED_MESSAGE, 409);

  return finish(
    await sendWhatsAppPayload({
      event: "whatsapp_inbox_text_send",
      logContext: logContext(input.access, input.conversationId, {}),
      message: {
        ...(input.replyToWamid ? { context: { message_id: input.replyToWamid } } : {}),
        text: { body: text, preview_url: true },
        type: "text",
      },
      phoneNumberId: conversation.line.phoneNumberId,
      toWaId: conversation.contactWaId,
    }),
  );
}

export async function sendInboxMedia(input: {
  access: AccessContext;
  conversationId: string;
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  caption?: string | null;
}) {
  const mimeType = input.mimeType.split(";")[0]!.trim().toLowerCase() || "application/octet-stream";
  const mediaType = outboundMediaTypeFor(mimeType);
  const problem = mediaLimitProblem(mediaType, input.bytes.length);
  if (problem) throw new WhatsAppInboxInputError(problem);
  const caption = input.caption?.trim() || null;
  if (caption && caption.length > INBOX_CAPTION_MAX_LENGTH) {
    throw new WhatsAppInboxInputError(`A caption can be at most ${INBOX_CAPTION_MAX_LENGTH} characters.`);
  }
  const fileName = input.fileName.trim() || "attachment";

  const conversation = await sendable(input.conversationId);
  if (!isReplyWindowOpen(conversation.lastInboundAt)) throw new WhatsAppInboxSendError(WINDOW_CLOSED_MESSAGE, 409);

  const storagePath = await storeInboxOutboundFile({ bytes: input.bytes, fileName, mimeType });
  let mediaId: string;
  try {
    mediaId = await uploadWhatsAppMedia({ bytes: input.bytes, fileName, mimeType, phoneNumberId: conversation.line.phoneNumberId });
  } catch (error) {
    throw new WhatsAppInboxSendError(error instanceof Error ? error.message : "WhatsApp did not accept the file.", 502);
  }

  const node: Record<string, unknown> = { id: mediaId };
  // WhatsApp shows no caption on a voice note, and names only a file.
  if (caption && mediaType !== "audio") node.caption = caption;
  if (mediaType === "document") node.filename = fileName;

  return finish(
    await sendWhatsAppPayload({
      event: "whatsapp_inbox_media_send",
      logContext: logContext(input.access, input.conversationId, {
        mediaByteSize: input.bytes.length,
        mediaFileName: fileName,
        mediaMimeType: mimeType,
        mediaStoragePath: storagePath,
      }),
      message: { [mediaType]: node, type: mediaType },
      phoneNumberId: conversation.line.phoneNumberId,
      toWaId: conversation.contactWaId,
    }),
  );
}

async function findTemplate(line: WhatsAppInboxLine, name: string, language: string): Promise<InboxTemplate> {
  let templates: InboxTemplate[];
  try {
    templates = await listApprovedTemplates(line.businessAccountId);
  } catch (error) {
    throw new WhatsAppInboxSendError(error instanceof Error ? error.message : "WhatsApp did not return the templates.", 502);
  }
  const template = templates.find((candidate) => candidate.name === name && candidate.language === language);
  if (!template) {
    throw new WhatsAppInboxInputError(`That template is not approved on the ${line.label}. Pick one from its list.`);
  }
  if (template.unsupportedReason) throw new WhatsAppInboxInputError(template.unsupportedReason);
  return template;
}

function cleanValues(values: Record<string, unknown> | null | undefined): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (typeof value === "string") clean[key] = value.replace(/[\r\n\t]+/g, " ").replace(/ {5,}/g, "    ").trim();
  }
  return clean;
}

async function sendTemplateTo(input: {
  access: AccessContext;
  conversationId: string | null;
  line: WhatsAppInboxLine;
  toWaId: string;
  templateName: string;
  language: string;
  values: Record<string, unknown> | null | undefined;
}) {
  const template = await findTemplate(input.line, input.templateName, input.language);
  const values = cleanValues(input.values);
  const missing = missingTemplateFields(template, values);
  if (missing.length > 0) throw new WhatsAppInboxInputError(`Fill in: ${missing.join(", ")}.`);

  return finish(
    await sendWhatsAppPayload({
      event: "whatsapp_inbox_template_send",
      logContext: {
        detail: {
          conversationId: input.conversationId,
          inbox: { renderedBody: renderInboxTemplate(template, values), sentByHrId: actorHrId(input.access) },
          source: "whatsapp_inbox",
        },
      },
      message: buildTemplateMessage(template, values),
      phoneNumberId: input.line.phoneNumberId,
      toWaId: input.toWaId,
    }),
  );
}

export async function sendInboxTemplate(input: {
  access: AccessContext;
  conversationId: string;
  templateName: string;
  language: string;
  values?: Record<string, unknown> | null;
}) {
  const conversation = await sendable(input.conversationId);
  return sendTemplateTo({ ...input, line: conversation.line, toWaId: conversation.contactWaId });
}

/** An Egyptian mobile in any common spelling, or an international number with its country code. */
export function normalizeNewChatNumber(value: string): string | null {
  const normalized = normalizePhone(value);
  if (!normalized) return null;
  return /^\d{10,15}$/.test(normalized) ? normalized : null;
}

/** Opens a chat with someone new, with an approved template — the only way WhatsApp allows a first message. */
export async function startInboxConversation(input: {
  access: AccessContext;
  phoneNumberId: string;
  phone: string;
  templateName: string;
  language: string;
  values?: Record<string, unknown> | null;
}): Promise<{ conversationId: string | null; wamid: string | null }> {
  const line = findWhatsAppInboxLine(input.phoneNumberId);
  if (!line) throw new WhatsAppInboxInputError("Pick which WhatsApp number to send from.");
  const toWaId = normalizeNewChatNumber(input.phone);
  if (!toWaId) throw new WhatsAppInboxInputError("That does not look like a mobile number. Use the full number, for example 01012345678.");

  const sent = await sendTemplateTo({ ...input, conversationId: null, line, toWaId });
  const { data } = await getSupabaseAdmin()
    .from(WHATSAPP_INBOX_CONVERSATIONS_TABLE)
    .select("id")
    .eq("phone_number_id", line.phoneNumberId)
    .eq("contact_key", toWaId)
    .maybeSingle();
  return { conversationId: (data as { id: string } | null)?.id ?? null, wamid: sent.wamid };
}
