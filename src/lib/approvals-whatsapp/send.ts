// Approvals WhatsApp — every send the owner makes from his screen on the approvals line.
//
// Each message goes through `sendWhatsAppPayload` with `source: "approvals_whatsapp"`; `postToGraph` sees the approvals
// line and records it in approvals_whatsapp_messages (never the recruitment log or the recruitment inbox). What this file
// owns is the refusals BEFORE Meta is asked — the 24-hour window, a username-only contact, an unapproved template, a
// batch over the TIER_250 limit — and the bulk send: server-side, one message per recipient, throttled, every result
// written to its own row, one failure never stopping the rest.

import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdForStorage } from "@/lib/hr-id";
import { afterResponse } from "@/lib/http/after-response";
import { logWarning } from "@/lib/observability/log";
import { sendWhatsAppPayload, type WhatsAppSendResult } from "@/lib/recruitment/inbound/whatsapp-interactive";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  approvalsReplyWindow,
  dedupeRecipients,
  fillParameterValues,
  normaliseApprovalsPhone,
  parseParameterMapping,
  parsePastedNumbers,
  tier250Check,
  type ApprovalsRecipient,
  type ParameterMapping,
  type TierCheck,
} from "@/lib/approvals-whatsapp/rules";
import {
  APPROVALS_BROADCAST_RECIPIENTS_TABLE,
  APPROVALS_BROADCASTS_TABLE,
  ApprovalsWhatsAppInputError,
  ApprovalsWhatsAppNotFoundError,
  approvalsContactedToday,
  employeesByWaId,
  findApprovalsConversationId,
  isMissingApprovalsTable,
  loadApprovalsConversationForSend,
  loadApprovalsEmployees,
  loadApprovalsListMembers,
  storeApprovalsOutboundFile,
  type ApprovalsEmployee,
} from "@/lib/approvals-whatsapp/store";
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
import { whatsAppApprovalsLine } from "@/lib/whatsapp-inbox/lines";

export const APPROVALS_TEXT_MAX_LENGTH = 4096;
export const APPROVALS_CAPTION_MAX_LENGTH = 1024;
/** Most recipients one bulk send may name — the daily limit is 250, so a bigger batch could never be sent anyway. */
export const APPROVALS_BATCH_MAX = 250;
/** The pause between two bulk messages. Meta allows far more per second; this keeps one send gentle on the line. */
export const APPROVALS_BULK_GAP_MS = 400;
/** A send still `sending` this long after its last message is treated as interrupted, and Resume may pick it up. */
export const APPROVALS_STALE_SEND_MS = 10 * 60 * 1000;

export const APPROVALS_WINDOW_CLOSED_MESSAGE =
  "More than 24 hours have passed since this person last wrote, so WhatsApp only allows an approved template now.";

export class ApprovalsWhatsAppSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApprovalsWhatsAppSendError";
  }
}

function failureMessage(result: Extract<WhatsAppSendResult, { ok: false }>): { message: string; status: number } {
  if (result.reason === "window_closed") return { message: APPROVALS_WINDOW_CLOSED_MESSAGE, status: 409 };
  if (result.reason === "disabled") return { message: "WhatsApp is not connected on this server.", status: 503 };
  return { message: `WhatsApp did not send the message${result.detail ? `: ${result.detail}` : "."}`, status: 502 };
}

function finish(result: WhatsAppSendResult): { wamid: string | null } {
  if (result.ok) return { wamid: result.wamid };
  const failure = failureMessage(result);
  throw new ApprovalsWhatsAppSendError(failure.message, failure.status);
}

function actorHrId(access: AccessContext): string | null {
  return hrIdForStorage(access.hrId) ?? access.loginId ?? null;
}

function line(): { phoneNumberId: string; businessAccountId: string } {
  const configured = whatsAppApprovalsLine();
  if (!configured) throw new ApprovalsWhatsAppSendError("The approvals line is not set up on this server.", 503);
  return configured;
}

/** The detail every send carries, so `postToGraph` files it in the approvals store with who sent it. */
export function approvalsLogContext(input: {
  sentByHrId: string | null;
  conversationId?: string | null;
  broadcastId?: string | null;
  renderedBody?: string | null;
  media?: { storagePath: string; mimeType: string; fileName: string; byteSize: number } | null;
}) {
  return {
    detail: {
      broadcastId: input.broadcastId ?? null,
      conversationId: input.conversationId ?? null,
      inbox: {
        mediaByteSize: input.media?.byteSize ?? null,
        mediaFileName: input.media?.fileName ?? null,
        mediaMimeType: input.media?.mimeType ?? null,
        mediaStoragePath: input.media?.storagePath ?? null,
        renderedBody: input.renderedBody ?? null,
        sentByHrId: input.sentByHrId,
      },
      source: "approvals_whatsapp",
    },
  };
}

async function sendableChat(conversationId: string): Promise<{ contactWaId: string; lastInboundAt: string | null }> {
  const conversation = await loadApprovalsConversationForSend(conversationId);
  if (conversation.problem || !conversation.contactWaId) {
    throw new ApprovalsWhatsAppSendError(conversation.problem ?? "This chat cannot be answered from Phoenix.", 409);
  }
  return { contactWaId: conversation.contactWaId, lastInboundAt: conversation.lastInboundAt };
}

/** Free text: only while the person's last message is under 24 hours old. */
export async function sendApprovalsText(input: { access: AccessContext; conversationId: string; text: string; replyToWamid?: string | null }) {
  const text = input.text.trim();
  if (!text) throw new ApprovalsWhatsAppInputError("Type a message first.");
  if (text.length > APPROVALS_TEXT_MAX_LENGTH) throw new ApprovalsWhatsAppInputError(`A WhatsApp message can be at most ${APPROVALS_TEXT_MAX_LENGTH} characters.`);
  const chat = await sendableChat(input.conversationId);
  if (!approvalsReplyWindow(chat.lastInboundAt).open) throw new ApprovalsWhatsAppSendError(APPROVALS_WINDOW_CLOSED_MESSAGE, 409);
  return finish(
    await sendWhatsAppPayload({
      event: "approvals_whatsapp_text_send",
      logContext: approvalsLogContext({ conversationId: input.conversationId, sentByHrId: actorHrId(input.access) }),
      message: {
        ...(input.replyToWamid ? { context: { message_id: input.replyToWamid } } : {}),
        text: { body: text, preview_url: true },
        type: "text",
      },
      phoneNumberId: line().phoneNumberId,
      toWaId: chat.contactWaId,
    }),
  );
}

/** A photo, video, voice note or file: only inside the 24-hour window, like free text. */
export async function sendApprovalsMedia(input: {
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
  if (problem) throw new ApprovalsWhatsAppInputError(problem);
  const caption = input.caption?.trim() || null;
  if (caption && caption.length > APPROVALS_CAPTION_MAX_LENGTH) {
    throw new ApprovalsWhatsAppInputError(`A caption can be at most ${APPROVALS_CAPTION_MAX_LENGTH} characters.`);
  }
  const fileName = input.fileName.trim() || "attachment";
  const chat = await sendableChat(input.conversationId);
  if (!approvalsReplyWindow(chat.lastInboundAt).open) throw new ApprovalsWhatsAppSendError(APPROVALS_WINDOW_CLOSED_MESSAGE, 409);
  const { phoneNumberId } = line();

  const storagePath = await storeApprovalsOutboundFile({ bytes: input.bytes, fileName, mimeType });
  let mediaId: string;
  try {
    mediaId = await uploadWhatsAppMedia({ bytes: input.bytes, fileName, mimeType, phoneNumberId });
  } catch (error) {
    throw new ApprovalsWhatsAppSendError(error instanceof Error ? error.message : "WhatsApp did not accept the file.", 502);
  }
  const node: Record<string, unknown> = { id: mediaId };
  if (caption && mediaType !== "audio") node.caption = caption;
  if (mediaType === "document") node.filename = fileName;

  return finish(
    await sendWhatsAppPayload({
      event: "approvals_whatsapp_media_send",
      logContext: approvalsLogContext({
        conversationId: input.conversationId,
        media: { byteSize: input.bytes.length, fileName, mimeType, storagePath },
        sentByHrId: actorHrId(input.access),
      }),
      message: { [mediaType]: node, type: mediaType },
      phoneNumberId,
      toWaId: chat.contactWaId,
    }),
  );
}

/** The approved templates of the approvals line's own account — the only wordings the composer may send. */
export async function listApprovalsApprovedTemplates(): Promise<InboxTemplate[]> {
  try {
    return await listApprovedTemplates(line().businessAccountId);
  } catch (error) {
    if (error instanceof ApprovalsWhatsAppSendError) throw error;
    throw new ApprovalsWhatsAppSendError(error instanceof Error ? error.message : "WhatsApp did not return the templates.", 502);
  }
}

async function findApprovedTemplate(name: string, language: string): Promise<InboxTemplate> {
  const template = (await listApprovalsApprovedTemplates()).find((candidate) => candidate.name === name && candidate.language === language);
  if (!template) throw new ApprovalsWhatsAppInputError("That wording is not approved by Meta yet. Pick one from the approved list.");
  if (template.unsupportedReason) throw new ApprovalsWhatsAppInputError(template.unsupportedReason);
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
  toWaId: string;
  templateName: string;
  language: string;
  values?: Record<string, unknown> | null;
}) {
  const template = await findApprovedTemplate(input.templateName, input.language);
  const values = cleanValues(input.values);
  const missing = missingTemplateFields(template, values);
  if (missing.length > 0) throw new ApprovalsWhatsAppInputError(`Fill in: ${missing.join(", ")}.`);
  return finish(
    await sendWhatsAppPayload({
      event: "approvals_whatsapp_template_send",
      logContext: approvalsLogContext({
        conversationId: input.conversationId,
        renderedBody: renderInboxTemplate(template, values),
        sentByHrId: actorHrId(input.access),
      }),
      message: buildTemplateMessage(template, values),
      phoneNumberId: line().phoneNumberId,
      toWaId: input.toWaId,
    }),
  );
}

/** An approved template to an existing chat — the only thing WhatsApp allows once the 24 hours have passed. */
export async function sendApprovalsTemplate(input: {
  access: AccessContext;
  conversationId: string;
  templateName: string;
  language: string;
  values?: Record<string, unknown> | null;
}) {
  const chat = await sendableChat(input.conversationId);
  await assertWithinDailyLimit([chat.contactWaId]);
  return sendTemplateTo({ ...input, toWaId: chat.contactWaId });
}

/** Opens a chat with a number nobody has written from yet, with an approved template. */
export async function startApprovalsConversation(input: {
  access: AccessContext;
  phone: string;
  templateName: string;
  language: string;
  values?: Record<string, unknown> | null;
}): Promise<{ conversationId: string | null; wamid: string | null }> {
  const toWaId = normaliseApprovalsPhone(input.phone);
  if (!toWaId) throw new ApprovalsWhatsAppInputError("That does not look like a mobile number. Use the full number, for example 01012345678.");
  await assertWithinDailyLimit([toWaId]);
  const sent = await sendTemplateTo({ ...input, conversationId: null, toWaId });
  return { conversationId: await findApprovalsConversationId(toWaId), wamid: sent.wamid };
}

async function assertWithinDailyLimit(batch: readonly string[]): Promise<TierCheck> {
  const check = tier250Check({ batch, contactedToday: await approvalsContactedToday() });
  if (!check.allowed) {
    throw new ApprovalsWhatsAppInputError(
      `This would pass today's WhatsApp limit of ${check.limit} people: ${check.usedToday} already reached in the last 24 hours, ${check.newContacts} new in this send. Remove ${check.overBy} or send tomorrow.`,
    );
  }
  return check;
}

// ── Bulk send ──

export type BulkRecipientInput = {
  employeeHrIds?: unknown;
  pasted?: unknown;
  listId?: unknown;
};

export type BulkPlanRecipient = ApprovalsRecipient & {
  name: string;
  values: Record<string, string>;
  renderedBody: string;
};

export type BulkPlan = {
  template: { name: string; language: string; bodyText: string };
  recipients: BulkPlanRecipient[];
  /** Employees chosen with no usable WhatsApp number on file. */
  noNumber: Array<{ hrId: string; name: string }>;
  invalidPasted: Array<{ text: string; reason: string }>;
  duplicates: Array<{ waId: string; name: string | null }>;
  /** Recipients a template field could not be filled for — named, and not sent. */
  unfilled: Array<{ waId: string; name: string; missing: string[] }>;
  tier: TierCheck;
  tooMany: boolean;
};

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, max).map((item) => item.trim());
}

/**
 * Everything a bulk send would do, worked out without sending: who receives it, what each one reads, who is skipped and
 * why, and whether today's limit allows it. The preview and the real send both start here, so they cannot disagree.
 */
export async function planApprovalsBroadcast(input: {
  templateName: string;
  language: string;
  mapping: unknown;
  recipients: BulkRecipientInput;
}): Promise<{ plan: BulkPlan; template: InboxTemplate; mapping: ParameterMapping; listId: string | null }> {
  const template = await findApprovedTemplate(input.templateName, input.language);
  const mapping = parseParameterMapping(input.mapping);
  const employees = await loadApprovalsEmployees();
  const byHrId = new Map(employees.map((employee) => [employee.hrId.trim().toUpperCase(), employee]));
  const byWaId = employeesByWaId(employees);

  const chosen: Array<ApprovalsRecipient & { employee: ApprovalsEmployee | null }> = [];
  const noNumber: BulkPlan["noNumber"] = [];
  for (const hrId of stringList(input.recipients.employeeHrIds, 5000)) {
    const employee = byHrId.get(hrId.toUpperCase());
    if (!employee) continue;
    if (!employee.waId) {
      noNumber.push({ hrId: employee.hrId, name: employee.name });
      continue;
    }
    chosen.push({ displayName: employee.name, employee, employeeHrId: employee.hrId, waId: employee.waId });
  }

  const listId = typeof input.recipients.listId === "string" && input.recipients.listId.trim() ? input.recipients.listId.trim() : null;
  if (listId) {
    for (const member of await loadApprovalsListMembers(listId)) {
      const employee = (member.employeeHrId ? byHrId.get(member.employeeHrId.trim().toUpperCase()) : null) ?? byWaId.get(member.waId) ?? null;
      chosen.push({ displayName: employee?.name ?? member.displayName, employee, employeeHrId: employee?.hrId ?? member.employeeHrId, waId: member.waId });
    }
  }

  const pasted = parsePastedNumbers(typeof input.recipients.pasted === "string" ? input.recipients.pasted : "");
  for (const waId of pasted.valid) {
    const employee = byWaId.get(waId) ?? null;
    chosen.push({ displayName: employee?.name ?? null, employee, employeeHrId: employee?.hrId ?? null, waId });
  }

  const { duplicates, recipients } = dedupeRecipients(chosen);
  const fieldKeys = [...template.headerFields, ...template.bodyFields].map((field) => field.key);
  const planned: BulkPlanRecipient[] = [];
  const unfilled: BulkPlan["unfilled"] = [];
  for (const recipient of recipients) {
    const name = recipient.displayName ?? `+${recipient.waId}`;
    const { missing, values } = fillParameterValues(fieldKeys, mapping, recipient.employee);
    if (missing.length > 0) {
      const labels = [...template.headerFields, ...template.bodyFields].filter((field) => missing.includes(field.key)).map((field) => field.label);
      unfilled.push({ missing: labels, name, waId: recipient.waId });
      continue;
    }
    planned.push({
      displayName: recipient.displayName,
      employeeHrId: recipient.employeeHrId,
      name,
      renderedBody: renderInboxTemplate(template, values),
      values,
      waId: recipient.waId,
    });
  }

  const tier = tier250Check({ batch: planned.map((recipient) => recipient.waId), contactedToday: await approvalsContactedToday() });
  return {
    listId,
    mapping,
    plan: {
      duplicates: [
        ...duplicates.map((duplicate) => ({ name: duplicate.displayName, waId: duplicate.waId })),
        ...pasted.duplicates.map((waId) => ({ name: byWaId.get(waId)?.name ?? null, waId })),
      ],
      invalidPasted: pasted.invalid,
      noNumber,
      recipients: planned,
      template: { bodyText: template.bodyText, language: template.language, name: template.name },
      tier,
      tooMany: planned.length > APPROVALS_BATCH_MAX,
      unfilled,
    },
    template,
  };
}

/** Writes the send and its recipients, then runs it after the reply. Refused whole when it would pass today's limit. */
export async function createApprovalsBroadcast(input: {
  access: AccessContext;
  templateName: string;
  language: string;
  mapping: unknown;
  recipients: BulkRecipientInput;
}): Promise<{ broadcastId: string; recipientCount: number }> {
  const { listId, mapping, plan, template } = await planApprovalsBroadcast(input);
  if (plan.recipients.length === 0) throw new ApprovalsWhatsAppInputError("Nobody in this send can receive it. Check the numbers and the fields.");
  if (plan.tooMany) throw new ApprovalsWhatsAppInputError(`One send can reach at most ${APPROVALS_BATCH_MAX} people.`);
  if (!plan.tier.allowed) {
    throw new ApprovalsWhatsAppInputError(
      `This would pass today's WhatsApp limit of ${plan.tier.limit} people: ${plan.tier.usedToday} already reached in the last 24 hours, ${plan.tier.newContacts} new in this send. Remove ${plan.tier.overBy} or send tomorrow.`,
    );
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(APPROVALS_BROADCASTS_TABLE)
    .insert({
      body_preview: template.bodyText,
      created_by_hr_id: actorHrId(input.access),
      list_id: listId,
      parameter_mapping: mapping,
      recipient_count: plan.recipients.length,
      status: "queued",
      template_language: template.language,
      template_name: template.name,
    })
    .select("id")
    .single();
  if (error) {
    if (isMissingApprovalsTable(error)) throw new ApprovalsWhatsAppSendError("The Approvals WhatsApp tables are not installed on this database yet.", 503);
    throw error;
  }
  const broadcastId = (data as { id: string }).id;
  const rows = plan.recipients.map((recipient) => ({
    broadcast_id: broadcastId,
    display_name: recipient.displayName,
    employee_hr_id: recipient.employeeHrId,
    parameter_values: recipient.values,
    rendered_body: recipient.renderedBody,
    status: "pending",
    wa_id: recipient.waId,
  }));
  const { error: recipientsError } = await supabase.from(APPROVALS_BROADCAST_RECIPIENTS_TABLE).insert(rows);
  if (recipientsError) {
    await supabase.from(APPROVALS_BROADCASTS_TABLE).update({ finished_at: new Date().toISOString(), status: "stopped" }).eq("id", broadcastId);
    throw recipientsError;
  }

  const sentBy = actorHrId(input.access);
  await afterResponse("approvals_whatsapp_broadcast", () => runApprovalsBroadcast({ broadcastId, sentByHrId: sentBy }));
  return { broadcastId, recipientCount: rows.length };
}

/** Picks an interrupted send back up: only its recipients still `pending` are sent. */
export async function resumeApprovalsBroadcast(input: { access: AccessContext; broadcastId: string }): Promise<{ pending: number }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(APPROVALS_BROADCASTS_TABLE)
    .select("id, status, started_at, finished_at")
    .eq("id", input.broadcastId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ApprovalsWhatsAppNotFoundError("That bulk send no longer exists.");
  const { count } = await supabase
    .from(APPROVALS_BROADCAST_RECIPIENTS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", input.broadcastId)
    .eq("status", "pending");
  const pending = count ?? 0;
  if (pending === 0) throw new ApprovalsWhatsAppInputError("Every recipient of this send has already been tried.");
  const row = data as { status: string; started_at: string | null };
  if (row.status === "sending" && row.started_at && Date.now() - Date.parse(row.started_at) < APPROVALS_STALE_SEND_MS) {
    throw new ApprovalsWhatsAppInputError("This send is still going. Its report fills in as each message is sent.");
  }
  const sentBy = actorHrId(input.access);
  await afterResponse("approvals_whatsapp_broadcast_resume", () => runApprovalsBroadcast({ broadcastId: input.broadcastId, sentByHrId: sentBy }));
  return { pending };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a bulk message to every recipient still `pending`, one at a time with a pause between. Each answer from Meta is
 * written to that recipient's row before the next is tried, so an interrupted run loses nothing and Resume continues it.
 * The template is looked up once at the start: a wording Meta withdrew in between fails every remaining row with that
 * reason instead of sending something else.
 */
export async function runApprovalsBroadcast(input: { broadcastId: string; sentByHrId: string | null; gapMs?: number }): Promise<{ accepted: number; failed: number }> {
  const supabase = getSupabaseAdmin();
  const gap = input.gapMs ?? APPROVALS_BULK_GAP_MS;
  const { data: broadcast, error } = await supabase
    .from(APPROVALS_BROADCASTS_TABLE)
    .select("id, template_name, template_language")
    .eq("id", input.broadcastId)
    .maybeSingle();
  if (error) throw error;
  if (!broadcast) return { accepted: 0, failed: 0 };
  const row = broadcast as { id: string; template_name: string; template_language: string };
  const startedAt = new Date().toISOString();
  await supabase.from(APPROVALS_BROADCASTS_TABLE).update({ finished_at: null, started_at: startedAt, status: "sending" }).eq("id", row.id);

  let template: InboxTemplate | null = null;
  let templateProblem: string | null = null;
  try {
    template = await findApprovedTemplate(row.template_name, row.template_language);
  } catch (problem) {
    templateProblem = problem instanceof Error ? problem.message : "The wording could not be read from WhatsApp.";
  }
  let phoneNumberId: string | null = null;
  try {
    phoneNumberId = line().phoneNumberId;
  } catch (problem) {
    templateProblem ??= problem instanceof Error ? problem.message : "The approvals line is not set up on this server.";
  }

  let accepted = 0;
  let failed = 0;
  const { data: pendingRows, error: pendingError } = await supabase
    .from(APPROVALS_BROADCAST_RECIPIENTS_TABLE)
    .select("id, wa_id, parameter_values, rendered_body")
    .eq("broadcast_id", row.id)
    .eq("status", "pending")
    .order("id", { ascending: true });
  if (pendingError) throw pendingError;

  const recipients = (pendingRows ?? []) as Array<{ id: string; wa_id: string; parameter_values: Record<string, string> | null; rendered_body: string | null }>;
  for (const [index, recipient] of recipients.entries()) {
    const at = new Date().toISOString();
    let update: Record<string, unknown>;
    if (!template || !phoneNumberId) {
      update = { failure_detail: templateProblem ?? "The wording is no longer approved.", sent_at: at, status: "failed" };
    } else {
      try {
        const values = cleanValues(recipient.parameter_values);
        const missing = missingTemplateFields(template, values);
        if (missing.length > 0) {
          update = { failure_detail: `Missing: ${missing.join(", ")}.`, sent_at: at, status: "failed" };
        } else {
          const result = await sendWhatsAppPayload({
            event: "approvals_whatsapp_bulk_send",
            logContext: approvalsLogContext({ broadcastId: row.id, renderedBody: recipient.rendered_body, sentByHrId: input.sentByHrId }),
            message: buildTemplateMessage(template, values),
            phoneNumberId,
            toWaId: recipient.wa_id,
          });
          update = result.ok
            ? { failure_detail: null, sent_at: at, status: "accepted", wamid: result.wamid }
            : { failure_detail: failureMessage(result).message, sent_at: at, status: "failed" };
        }
      } catch (problem) {
        update = { failure_detail: problem instanceof Error ? problem.message.slice(0, 500) : "The send threw.", sent_at: at, status: "failed" };
      }
    }
    if (update.status === "accepted") accepted += 1;
    else failed += 1;
    const { error: writeError } = await supabase.from(APPROVALS_BROADCAST_RECIPIENTS_TABLE).update(update).eq("id", recipient.id).eq("status", "pending");
    if (writeError) {
      logWarning("Approvals WhatsApp bulk recipient result not written", {
        context: { broadcastId: row.id, code: writeError.code ?? null },
        labels: { event: "approvals_whatsapp_bulk_write_failed" },
      });
    }
    if (index < recipients.length - 1 && gap > 0) await sleep(gap);
  }

  await refreshBroadcastCounts(row.id, "done");
  return { accepted, failed };
}

/** Counts are read back from the recipient rows, so a resumed send never double counts. */
async function refreshBroadcastCounts(broadcastId: string, status: "done" | "stopped"): Promise<void> {
  const supabase = getSupabaseAdmin();
  const count = async (value: string) => {
    const { count: total } = await supabase
      .from(APPROVALS_BROADCAST_RECIPIENTS_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("broadcast_id", broadcastId)
      .eq("status", value);
    return total ?? 0;
  };
  const [accepted, failed, pending] = await Promise.all([count("accepted"), count("failed"), count("pending")]);
  await supabase
    .from(APPROVALS_BROADCASTS_TABLE)
    .update({ accepted_count: accepted, failed_count: failed, finished_at: new Date().toISOString(), status: pending > 0 ? "stopped" : status })
    .eq("id", broadcastId);
}
