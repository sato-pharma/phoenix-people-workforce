import type { EmailDispatch, PreparedEmail } from "@/lib/email/email-providers";
import { JOB_OFFER_SENDER_ADDRESS } from "@/lib/email/job-offer-sender";
import { splitAddressList } from "@/lib/email/receivable-address";
import { normalizeAppPassword } from "@/lib/mailbox-monitor/imap-error";
import { logError } from "@/lib/observability/log";
import { describeSmtpError, isAuthenticationFailure } from "@/lib/personal-mailbox/rules";
import type { PersonalMailboxCredential } from "@/lib/personal-mailbox/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * A job offer, sent through the REAL `hr@satopharma.com` mailbox on Turbify (owner, 2026-11-06: "send
 * job offers through the real hr@ mailbox").
 *
 * ── Why ──
 * The company's mailboxes live on Turbify (Yahoo Business Mail). An offer sent by Resend (Amazon SES)
 * claiming `hr@satopharma.com` arrives at a Yahoo-hosted domain from a relay that is not Yahoo's, which
 * is the shape of a spoofed sender: production `email_delivery_events` held 112 apex-From sends over 35
 * days and 0 opens, and the copies sat in Bulk. Mail handed to Turbify's own submission server as the
 * mailbox itself is the company's real mail, and it lands in that mailbox's Sent folder like any other.
 *
 * ── Switched on by one variable ──
 * `JOB_OFFER_SMTP_APP_PASSWORD` — an app password minted for `hr@satopharma.com` in Turbify, pasted
 * as shown (spaces are stripped the way the mailbox monitor strips them). Unset or blank, nothing here
 * runs: `jobOfferSmtpDispatch()` answers `undefined` and the offer takes the ordinary provider chain.
 *
 * ── What it never does ──
 * It never falls back to Resend. A refused login, an unreachable server or a refused candidate address
 * throws `JobOfferSmtpError` with a sentence HR can read (built from the reply CODE only, never the
 * server's text, which can quote an address), and the offer stays a draft. The Sent copy is a
 * courtesy: a failure there is logged and the offer still counts as sent — it is never sent twice.
 */

export const JOB_OFFER_SMTP_PASSWORD_ENV = "JOB_OFFER_SMTP_APP_PASSWORD";

/** The `provider` an offer sent this way is recorded under in `email_delivery_events`. */
export const JOB_OFFER_SMTP_PROVIDER = "turbify";

/** How long a sent offer's idempotency key is remembered, so a double press sends once. */
const SENT_KEY_MEMORY_MS = 10 * 60_000;

/** A failure HR is shown. Hand-written sentences only — `clientSafeErrorMessage` passes them through. */
export class JobOfferSmtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobOfferSmtpError";
  }
}

/** The app password for the hr@ mailbox, normalised — "" when the variable is unset or blank. */
export function jobOfferSmtpAppPassword(env: Record<string, string | undefined> = process.env): string {
  return normalizeAppPassword(env[JOB_OFFER_SMTP_PASSWORD_ENV] ?? "");
}

/**
 * The From for the Turbify send: the offer's own display name, on `hr@satopharma.com`.
 *
 * The mailbox logged in IS `hr@` on the apex, and Turbify sends only as the mailbox it logged in as —
 * so a `JOB_OFFER_EMAIL_FROM` naming the sending subdomain (`hr@send.…`, allowed by the owner's rule)
 * still goes out as the apex address, which is the one the candidate can reply to.
 */
export function jobOfferSmtpFrom(from: string): { address: string; name: string } {
  const match = String(from ?? "").match(/^\s*"?(.*?)"?\s*<[^>]+>\s*$/);
  return { address: JOB_OFFER_SENDER_ADDRESS, name: (match?.[1] ?? "").trim() };
}

/** The sentence HR reads when Turbify did not take the offer. */
export function jobOfferSmtpFailureMessage(error: unknown): string {
  if (isAuthenticationFailure(error)) {
    return `The offer was not sent: Turbify refused the app password for ${JOB_OFFER_SENDER_ADDRESS}. ${JOB_OFFER_SMTP_PASSWORD_ENV} needs a new app password minted for that mailbox.`;
  }
  return `The offer was not confirmed as sent from ${JOB_OFFER_SENDER_ADDRESS}: ${describeSmtpError(error)}. Look in that mailbox's Sent folder before sending it again.`;
}

type ComposeOptions = {
  attachments?: Array<{ cid?: string; content: Buffer; contentType?: string; filename: string }>;
  cc?: string[];
  from: { address: string; name: string };
  headers?: Record<string, string>;
  html: string;
  replyTo?: string[];
  subject: string;
  text: string;
  to: string[];
};

export type JobOfferDeliveryEvent = {
  event_type: string;
  failure_reason: string | null;
  occurred_at: string;
  provider: typeof JOB_OFFER_SMTP_PROVIDER;
  provider_event_id: string;
  provider_message_id: string | null;
  raw_event: Record<string, unknown>;
  recipients: string[];
  sender: string;
  status: "failed" | "sent";
  subject: string;
};

/** The four things the send does that touch the outside world — injectable, so a test sends nothing. */
export type JobOfferSmtpTransport = {
  compose(options: ComposeOptions): Promise<{ messageId: string; raw: Buffer }>;
  fileInSent(credential: PersonalMailboxCredential, raw: Buffer, messageId: string): Promise<unknown>;
  record(row: JobOfferDeliveryEvent): Promise<void>;
  send(
    credential: PersonalMailboxCredential,
    envelope: { from: string; to: string[] },
    raw: Buffer,
  ): Promise<{ rejected: string[] }>;
};

/**
 * The real transport: the personal mailbox's own nodemailer and IMAP helpers (one Turbify transport in
 * the codebase, not two). Loaded on first use, so importing the offer module costs no mail client.
 */
export const turbifyJobOfferTransport: JobOfferSmtpTransport = {
  async compose(options) {
    const { composeRawMessage } = await import("@/lib/personal-mailbox/smtp");
    return composeRawMessage(options);
  },
  async fileInSent(credential, raw, messageId) {
    const { ensureCopyInSent } = await import("@/lib/personal-mailbox/imap");
    return ensureCopyInSent(credential, raw, messageId);
  },
  async record(row) {
    const { error } = await getSupabaseAdmin().from("email_delivery_events").insert(row);
    if (error) throw error;
  },
  async send(credential, envelope, raw) {
    const { sendComposedMessage } = await import("@/lib/personal-mailbox/smtp");
    return sendComposedMessage(credential, envelope, raw);
  },
};

function lowerUnique(addresses: Array<string | undefined>): string[] {
  return [...new Set(addresses.map((address) => String(address ?? "").trim().toLowerCase()).filter(Boolean))];
}

/** The reply code and error class only — never the server's text, which can quote an address. */
function smtpErrorContext(error: unknown) {
  const e = (error && typeof error === "object" ? error : {}) as { code?: unknown; responseCode?: unknown };
  return {
    code: typeof e.code === "string" ? e.code : null,
    responseCode: typeof e.responseCode === "number" ? e.responseCode : null,
  };
}

async function recordQuietly(transport: JobOfferSmtpTransport, row: JobOfferDeliveryEvent) {
  try {
    await transport.record(row);
  } catch (error) {
    logError("Job offer delivery event could not be recorded", {
      error,
      labels: { event: "job_offer_smtp_record_failed", status: row.status },
    });
  }
}

const sentKeys = new Map<string, { at: number; result: Promise<{ id: string; provider: string }> }>();

/**
 * The dispatcher `sendPhoenixEmail` hands the prepared offer to when the hr@ app password is set —
 * `undefined` when it is not, which keeps the ordinary provider chain exactly as it was.
 *
 * Everything before the dispatch stays in `sendPhoenixEmail`: the suppression list, the Recipient
 * Assurance Guard, the Notification Confidence Gate and its record, and — after it — the admin
 * Telegram mirror. Only the hand-off to a provider changes.
 */
export function jobOfferSmtpDispatch(transport: JobOfferSmtpTransport = turbifyJobOfferTransport): EmailDispatch | undefined {
  const password = jobOfferSmtpAppPassword();
  if (!password) return undefined;
  const credential: PersonalMailboxCredential = { password, user: JOB_OFFER_SENDER_ADDRESS };

  return (email: PreparedEmail) => {
    // SMTP has no idempotency key of its own (Resend's header made a double press safe). A key that
    // already went out, or is going out, answers with that send instead of a second letter.
    const now = Date.now();
    for (const [key, entry] of sentKeys) if (now - entry.at > SENT_KEY_MEMORY_MS) sentKeys.delete(key);
    const known = sentKeys.get(email.idempotencyKey);
    if (known) return known.result;
    const result = sendThroughTurbify(email, credential, transport);
    sentKeys.set(email.idempotencyKey, { at: now, result });
    // A failed send is forgotten at once, so pressing Send again really tries again.
    result.catch(() => sentKeys.delete(email.idempotencyKey));
    return result;
  };
}

async function sendThroughTurbify(
  email: PreparedEmail,
  credential: PersonalMailboxCredential,
  transport: JobOfferSmtpTransport,
): Promise<{ id: string; provider: string }> {
  const from = jobOfferSmtpFrom(email.from);
  const sender = from.name ? `${from.name} <${from.address}>` : from.address;
  const recipients = lowerUnique(email.to);
  const replyTo = splitAddressList(email.replyTo);
  const failed = async (message: string, error: unknown) => {
    logError("Job offer could not be sent through the hr@ Turbify mailbox", {
      context: smtpErrorContext(error),
      labels: { event: "job_offer_smtp_send_failed" },
    });
    await recordQuietly(transport, {
      event_type: "email.failed",
      failure_reason: message,
      occurred_at: new Date().toISOString(),
      provider: JOB_OFFER_SMTP_PROVIDER,
      provider_event_id: `${JOB_OFFER_SMTP_PROVIDER}:failed:${email.idempotencyKey}:${Date.now()}`,
      provider_message_id: null,
      raw_event: { source: "job-offer-smtp", ...smtpErrorContext(error) },
      recipients,
      sender,
      status: "failed",
      subject: email.subject,
    });
    return new JobOfferSmtpError(message);
  };

  let composed: { messageId: string; raw: Buffer };
  try {
    composed = await transport.compose({
      // An inline part (the letterhead) keeps its Content-ID, so the body's `cid:` reference resolves
      // exactly as it does on Resend; the PDF stays an ordinary attachment.
      attachments: (email.attachments ?? []).map((attachment) => ({
        cid: attachment.contentId,
        content: Buffer.from(attachment.content, "base64"),
        contentType: attachment.contentType,
        filename: attachment.filename,
      })),
      cc: email.cc && email.cc.length > 0 ? email.cc : undefined,
      from,
      headers: email.headers,
      html: email.html,
      replyTo: replyTo.length > 0 ? replyTo : undefined,
      subject: email.subject,
      text: email.text,
      to: email.to,
    });
  } catch (error) {
    throw await failed(`The offer was not sent: the letter could not be prepared for ${JOB_OFFER_SENDER_ADDRESS}.`, error);
  }

  // Every addressee travels in the envelope; a BCC never appears in the message itself.
  const envelopeTo = lowerUnique([...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])]);
  let rejected: string[];
  try {
    ({ rejected } = await transport.send(credential, { from: JOB_OFFER_SENDER_ADDRESS, to: envelopeTo }, composed.raw));
  } catch (error) {
    throw await failed(jobOfferSmtpFailureMessage(error), error);
  }

  const refused = new Set(lowerUnique(rejected));
  if (recipients.some((address) => refused.has(address))) {
    // The candidate never got it. Any copy that was accepted did go — which is why this is not retried
    // behind HR's back, and why the message says to look in Sent first.
    throw await failed(
      `The offer was not sent to the candidate: the outgoing mail server refused the candidate's address. Check it, and look in ${JOB_OFFER_SENDER_ADDRESS}'s Sent folder before sending again.`,
      { code: "EENVELOPE" },
    );
  }
  if (refused.size > 0) {
    logError("Job offer reached the candidate, but Turbify refused a copy address", {
      context: { refusedCount: refused.size },
      labels: { event: "job_offer_smtp_copy_refused" },
    });
  }

  // The courtesy half. Yahoo files mail sent through its own server by itself; `ensureCopyInSent`
  // looks first and appends only what is missing. A failure never fails, or resends, the offer.
  let filedInSent = true;
  try {
    await transport.fileInSent(credential, composed.raw, composed.messageId);
  } catch (error) {
    filedInSent = false;
    logError("Job offer was sent, but its copy could not be filed in the hr@ Sent folder", {
      context: smtpErrorContext(error),
      labels: { event: "job_offer_smtp_file_sent_failed" },
    });
  }

  await recordQuietly(transport, {
    event_type: "email.sent",
    failure_reason: null,
    occurred_at: new Date().toISOString(),
    provider: JOB_OFFER_SMTP_PROVIDER,
    provider_event_id: `${JOB_OFFER_SMTP_PROVIDER}:sent:${composed.messageId}`,
    provider_message_id: composed.messageId,
    raw_event: { filedInSent, refusedCopies: refused.size, source: "job-offer-smtp" },
    recipients,
    sender,
    status: "sent",
    subject: email.subject,
  });

  return { id: composed.messageId, provider: JOB_OFFER_SMTP_PROVIDER };
}
