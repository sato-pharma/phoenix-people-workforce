import { createHash } from "node:crypto";

import { sendTemplatedEmail, type SendTemplatedEmailInput } from "@/lib/email-templates/service";
import {
  sendPhoenixEmail,
  type SendPhoenixEmailInput,
  type SendPhoenixEmailResult,
} from "@/lib/email/send-phoenix-email";

/**
 * A DURABLE DIRECT EMAIL — the outbox row behind an approval email that used to be sent straight to
 * the provider (REC-048, 13 Nov 2026).
 *
 * The leave emails (request, hand-off, step result, final decision, returned, balance settlement) and
 * the two background recruitment emails (interview invitation on schedule, interview feedback) call
 * `sendTemplatedEmail` / `sendPhoenixEmail` directly. If the provider failed, the email was gone and
 * nobody saw it. They now write a `notification_outbox` row FIRST whose payload is this shape — the
 * EXACT input the sender was given — and the drain retries it by calling the SAME sender with that
 * input, unchanged: the same To, CC, subject, template and body the inline send would have used.
 *
 * 🔴 It never goes through the standard notification path (`sendNotificationEmailDirect`): that path
 * resolves recipients by policy, adds the manager CC and swaps templates — the drain branches on
 * `kind === "direct_email"` before any of it runs (`processNotificationOutboxRow`).
 *
 * This module holds no database code, so the payload rules are testable on their own.
 */

export const DIRECT_EMAIL_PAYLOAD_KIND = "direct_email" as const;

/** The sender and the exact input it is called with — inline and on every retry. */
export type DurableEmailMessage =
  | { input: SendTemplatedEmailInput; sender: "templated" }
  | { input: SendPhoenixEmailInput; sender: "phoenix" };

export type DirectEmailPayload = {
  kind: typeof DIRECT_EMAIL_PAYLOAD_KIND;
  /** The caller's own readable key (`vacation:<request>:leave_request:<manager>`), for a person reading the row. */
  label: string;
  message: DurableEmailMessage;
  originEnvironment?: string;
  // ── Who and what, at the top level, so Email Activity and the admin list read a direct email the
  // way they read every other outbox row. Display only: the send reads `message` and nothing else.
  employeeHrId?: string | null;
  eventType?: string | null;
  module?: string | null;
  recipients?: string[];
  subject?: string | null;
  /** Stamped when the row is marked sent and the body and figures were deleted (sent-figures.ts). */
  figuresCleared?: true;
};

export type DirectEmailSenders = {
  sendPhoenixEmail: (input: SendPhoenixEmailInput) => Promise<SendPhoenixEmailResult>;
  sendTemplatedEmail: (input: SendTemplatedEmailInput) => Promise<SendPhoenixEmailResult>;
};

const defaultSenders: DirectEmailSenders = { sendPhoenixEmail, sendTemplatedEmail };

export function isDirectEmailPayload(value: unknown): value is DirectEmailPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<DirectEmailPayload>;
  if (payload.kind !== DIRECT_EMAIL_PAYLOAD_KIND) return false;
  const message = payload.message as Partial<DurableEmailMessage> | undefined;
  return Boolean(message && (message.sender === "templated" || message.sender === "phoenix") && message.input);
}

/**
 * Sends a stored direct email: the same sender, the stored input, nothing added and nothing taken
 * away. `senders` is injectable for the tests only.
 */
export function sendDirectEmailMessage(
  message: DurableEmailMessage,
  senders: DirectEmailSenders = defaultSenders,
): Promise<SendPhoenixEmailResult> {
  if (message.sender === "templated") return senders.sendTemplatedEmail(message.input);
  return senders.sendPhoenixEmail(message.input);
}

function cleanList(values: Array<string | null | undefined> | null | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean)));
}

/** The visible To the sender was asked for — the override list, else the fallback, else the candidate. */
function messageRecipients(message: DurableEmailMessage): string[] {
  if (message.sender === "phoenix") return cleanList(message.input.to);
  const input = message.input;
  const overrides = cleanList(input.overrides?.to ?? []);
  if (overrides.length > 0) return overrides;
  const fallback = cleanList(input.fallbackTo ?? []);
  if (fallback.length > 0) return fallback;
  return cleanList([input.candidateEmail]);
}

function messageSubject(message: DurableEmailMessage): string | null {
  if (message.sender === "phoenix") return message.input.subject || null;
  const contextSubject = message.input.context?.subject;
  return typeof contextSubject === "string" && contextSubject.trim() ? contextSubject : String(message.input.templateKey);
}

export function buildDirectEmailPayload(
  message: DurableEmailMessage,
  label: string,
  originEnvironment: string,
): DirectEmailPayload {
  const origin = message.input.origin ?? null;
  const employeeHrId = message.sender === "templated"
    ? message.input.employeeHrId ?? origin?.employeeHrId ?? null
    : origin?.employeeHrId ?? null;
  return {
    employeeHrId,
    eventType: origin?.eventType ?? (message.sender === "templated" ? String(message.input.templateKey) : null),
    kind: DIRECT_EMAIL_PAYLOAD_KIND,
    label,
    message,
    module: origin?.module ?? null,
    originEnvironment,
    recipients: messageRecipients(message),
    subject: messageSubject(message),
  };
}

/**
 * The payload a SENT direct email keeps (owner, 13 Nov 2026: "email figures cleared at send"): who,
 * what and when. The rendered body, the template's context (the leave balance, the settlement amount,
 * the details table) and any attachment are deleted; the recipients, the subject, the template and the
 * idempotency key stay so the row still says which email it was.
 */
export function directEmailSentPayload(payload: DirectEmailPayload): DirectEmailPayload {
  const { message } = payload;
  const kept: DurableEmailMessage = message.sender === "phoenix"
    ? {
        input: {
          bcc: message.input.bcc,
          cc: message.input.cc,
          html: "",
          idempotencyKey: message.input.idempotencyKey,
          origin: message.input.origin ?? null,
          subject: message.input.subject,
          text: "",
          to: message.input.to,
        },
        sender: "phoenix",
      }
    : {
        input: {
          candidateEmail: message.input.candidateEmail ?? null,
          employeeHrId: message.input.employeeHrId ?? null,
          fallbackTo: message.input.fallbackTo ?? null,
          idempotencyKey: message.input.idempotencyKey ?? null,
          origin: message.input.origin ?? null,
          overrides: message.input.overrides,
          templateKey: message.input.templateKey,
        },
        sender: "templated",
      };
  return { ...payload, figuresCleared: true, message: kept };
}

/** Cairo calendar day, `YYYY-MM-DD`. */
function cairoDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(now);
}

/**
 * The outbox `dedupe_key` of a durable direct email.
 *
 * The caller's own key comes first, so the row reads as the email it is. Behind it:
 *
 * - the Cairo DAY: a request retried the same day finds its row and never queues a second email, yet
 *   the same email legitimately sent again on a later day (returned, resubmitted, returned again with
 *   the same words) is not swallowed for ever — the provider's own idempotency window is 24 hours, and
 *   this keeps to it;
 * - a digest of the whole message: two different emails under one caller key (a second manager step
 *   for the same request) are two rows, never one silently dropped.
 */
export function durableEmailDedupeKey(message: DurableEmailMessage, callerKey: string, now: Date = new Date()): string {
  const digest = createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 32);
  return `durable-email:${callerKey.trim()}:${cairoDay(now)}:${digest}`;
}
