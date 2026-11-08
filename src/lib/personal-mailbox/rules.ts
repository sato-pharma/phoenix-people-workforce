// Personal mailbox — pure rules. No I/O and no mail-client imports, so everything here is unit-tested
// directly (tests/personal-mailbox.test.ts) and the envelope's client component can import it too.

import type {
  PersonalMailboxAlertItem,
  PersonalMailboxFolder,
  PersonalMailboxMessage,
  PersonalMailboxSendInput,
} from "@/lib/personal-mailbox/types";

/**
 * The secret-box context every personal app password is sealed under. A different context derives a
 * different key, so the compliance monitor — which opens with no context — cannot decrypt one of
 * these even holding the blob. Changing this string strands every stored connection.
 */
export const PERSONAL_MAILBOX_SECRET_CONTEXT = "personal-mailbox";

/** Turbify business mail runs on Yahoo's servers. IMAP matches the monitor's working setting. */
export const TURBIFY_IMAP = { host: "imap.mail.yahoo.com", port: 993, secure: true } as const;
/**
 * Turbify's BUSINESS submission server, implicit TLS — the outgoing server Turbify's own help names
 * for a business mailbox. Never `smtp.mail.yahoo.com`, Yahoo's consumer server: it accepts the
 * business mailbox's login and then refuses every message sent as `@satopharma.com` with reply 550
 * at the message stage — both job offers sent as hr@ on 8 Nov 2026 were refused that way, and no
 * message ever left through it. Used by the personal mailbox and by job offers (job-offer-smtp.ts).
 */
export const TURBIFY_SMTP = { host: "smtp.bizmail.yahoo.com", port: 465, secure: true } as const;

export const PERSONAL_MAILBOX_PAGE_SIZE = 30;
export const MAX_RECIPIENTS = 50;
export const MAX_SUBJECT_LENGTH = 500;
export const MAX_BODY_LENGTH = 100_000;
/** Yahoo accepts 25 MB; base64 inflates by a third, so 15 MB of files stays well under it. */
export const MAX_ATTACHMENT_TOTAL_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
/** Inline images (a signature logo) are embedded into the reader up to this much in total. */
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

/** How many of the newest unread emails one inbox check brings back for new-mail alerts. */
export const PERSONAL_MAILBOX_ALERT_LIMIT = 5;
/**
 * How often an open Phoenix tab asks whether new email arrived. Each ask is one read-only login on
 * the person's own mailbox; the server answers repeat asks from its short cache instead.
 */
export const PERSONAL_MAILBOX_POLL_MS = 2 * 60_000;
/** Fired on `window` when the person connects, reconnects or disconnects, so the envelope re-checks. */
export const PERSONAL_MAILBOX_CHANGED_EVENT = "phx:personal-mailbox-changed";
/** Fired on `window` when an unread inbox email is opened, so the envelope's count drops by one. */
export const PERSONAL_MAILBOX_READ_EVENT = "phx:personal-mailbox-read";

/** Thrown for every expected refusal. `diagnostic` marks the ones worth an error-monitor row. */
export class PersonalMailboxError extends Error {
  readonly statusCode: number;
  readonly diagnostic: boolean;

  constructor(message: string, statusCode = 400, options: { diagnostic?: boolean } = {}) {
    super(message);
    this.name = "PersonalMailboxError";
    this.statusCode = statusCode;
    this.diagnostic = options.diagnostic ?? false;
  }
}

/**
 * Whose connection a request is about. ALWAYS derived from the resolved session and never from the
 * request, so there is no input by which one person could name another's mailbox. HR id first (upper
 * case), login id for the one kind of account that has none.
 */
export function mailboxOwnerKey(access: { hrId?: string | null; loginId?: string | null }): string | null {
  const hrId = access.hrId?.trim();
  if (hrId) return hrId.toUpperCase();
  const loginId = access.loginId?.trim();
  return loginId ? loginId.toLowerCase() : null;
}

export function normalizeAddress(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

const ADDRESS_PATTERN = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/;

export function isPlausibleAddress(value: string): boolean {
  return value.length <= 320 && ADDRESS_PATTERN.test(value);
}

/**
 * Split what a person typed into a To or Cc box. Commas, semicolons and new lines all separate, and
 * the "Name <address>" form a copied address arrives in keeps only the address. Duplicates collapse.
 */
export function parseAddressList(raw: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of (raw ?? "").split(/[,;\n]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const bracketed = /<([^>]+)>/.exec(trimmed);
    const address = normalizeAddress(bracketed ? bracketed[1] : trimmed);
    if (!isPlausibleAddress(address)) {
      invalid.push(trimmed);
      continue;
    }
    if (!valid.includes(address)) valid.push(address);
  }
  return { invalid, valid };
}

export function parseFolder(value: string | null | undefined): PersonalMailboxFolder | null {
  const folder = (value ?? "").trim().toLowerCase();
  return folder === "inbox" || folder === "sent" ? folder : null;
}

/** "Re: " once, never "Re: Re: ". */
export function replySubject(subject: string | null): string {
  const base = (subject ?? "").trim();
  if (/^re\s*:/i.test(base)) return base;
  return base ? `Re: ${base}` : "Re:";
}

function formatCairo(iso: string | null): string {
  if (!iso) return "an earlier date";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "an earlier date";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(date);
}

/** The original message, quoted under the reply the way every mail client does it. */
export function quoteForReply(message: Pick<PersonalMailboxMessage, "date" | "fromAddress" | "fromName" | "text">): string {
  const who = message.fromName && message.fromAddress
    ? `${message.fromName} <${message.fromAddress}>`
    : message.fromAddress ?? message.fromName ?? "the sender";
  const lines = (message.text ?? "").replace(/\r\n/g, "\n").trimEnd().split("\n");
  const quoted = lines.map((line) => (line ? `> ${line}` : ">")).join("\n");
  return `\n\nOn ${formatCairo(message.date)}, ${who} wrote:\n${quoted}\n`;
}

/**
 * Who a reply goes to. Reply goes to the Reply-To (else the sender); Reply all adds everyone else on
 * To and Cc. The owner's own address is never put back on a reply to themselves — and a reply to
 * an email the owner SENT (opened from Sent) goes to that email's recipients, as webmail does.
 */
export function replyRecipients(
  message: Pick<PersonalMailboxMessage, "ccAddresses" | "fromAddress" | "replyToAddresses" | "toAddresses">,
  ownAddress: string,
  all: boolean,
): { to: string[]; cc: string[] } {
  const self = normalizeAddress(ownAddress);
  const unique = (values: Array<string | null>) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      const address = normalizeAddress(value);
      if (!address || address === self || seen.has(address)) continue;
      seen.add(address);
      out.push(address);
    }
    return out;
  };
  const primary = message.replyToAddresses.length > 0 ? message.replyToAddresses : [message.fromAddress];
  let to = unique(primary);
  if (to.length === 0) to = unique(message.toAddresses);
  if (!all) return { cc: [], to };
  const cc = unique([...message.toAddresses, ...message.ccAddresses]).filter((address) => !to.includes(address));
  return { cc, to };
}

/** The References chain a reply carries, so the other side's client threads it. */
export function replyReferences(message: Pick<PersonalMailboxMessage, "messageId" | "references">): string[] {
  const chain = [...message.references];
  if (message.messageId && !chain.includes(message.messageId)) chain.push(message.messageId);
  // Mail servers cap header length; the most recent links are the ones threading needs.
  return chain.slice(-20);
}

/** Refuse anything the mail server would, before a login is spent on it. */
export function validateSendInput(input: PersonalMailboxSendInput): void {
  const recipients = input.to.length + input.cc.length;
  if (input.to.length === 0) throw new PersonalMailboxError("Add at least one address in To.");
  if (recipients > MAX_RECIPIENTS) {
    throw new PersonalMailboxError(`One email can go to at most ${MAX_RECIPIENTS} addresses.`);
  }
  for (const address of [...input.to, ...input.cc]) {
    if (!isPlausibleAddress(address)) throw new PersonalMailboxError(`"${address}" is not an email address.`);
  }
  if (input.subject.length > MAX_SUBJECT_LENGTH) throw new PersonalMailboxError("The subject is too long.");
  if (!input.subject.trim() && !input.body.trim() && input.attachments.length === 0) {
    throw new PersonalMailboxError("The email is empty.");
  }
  if (input.body.length > MAX_BODY_LENGTH) throw new PersonalMailboxError("The message is too long.");
  if (input.attachments.length > MAX_ATTACHMENTS) {
    throw new PersonalMailboxError(`Attach at most ${MAX_ATTACHMENTS} files.`);
  }
  const total = input.attachments.reduce((sum, file) => sum + file.content.length, 0);
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new PersonalMailboxError("The attachments are over 15 MB together.");
  }
}

/**
 * True when a mail server refused the stored app password — IMAP (imapflow) or SMTP (nodemailer).
 * This is the one failure that must stop Phoenix retrying: Yahoo locks a mailbox after enough failed
 * logins, and that lockout would land on the owner's real email.
 */
export function isAuthenticationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    authenticationFailed?: unknown;
    code?: unknown;
    responseCode?: unknown;
    serverResponseCode?: unknown;
  };
  if (e.authenticationFailed === true) return true;
  if (e.serverResponseCode === "AUTHENTICATIONFAILED") return true;
  if (e.code === "EAUTH") return true;
  return e.responseCode === 535;
}

/**
 * A reason a person can act on for a failed SMTP step. Built from the reply CODE only, never the
 * server's own text or nodemailer's message (which appends it): a refusal usually quotes a recipient's
 * address, and this string is also what the error monitor records.
 */
export function describeSmtpError(error: unknown): string {
  if (isAuthenticationFailure(error)) {
    return "the mailbox refused the app password for sending (create a new app password and paste it with no spaces)";
  }
  const e = (error && typeof error === "object" ? error : {}) as { code?: unknown; responseCode?: unknown };
  if (e.code === "ETIMEDOUT" || e.code === "ECONNECTION" || e.code === "ESOCKET" || e.code === "EDNS") {
    return "the outgoing mail server could not be reached";
  }
  const reply = typeof e.responseCode === "number" && Number.isInteger(e.responseCode) ? e.responseCode : null;
  const suffix = reply === null ? "" : ` (reply ${reply})`;
  if (e.code === "EENVELOPE") return `the outgoing mail server refused the recipients${suffix}`;
  if (reply === 552 || reply === 523) return `the email is too large for the outgoing mail server${suffix}`;
  if (reply !== null && reply >= 400 && reply < 500) return `the outgoing mail server is busy — try again later${suffix}`;
  return `the outgoing mail server refused the email${suffix}`;
}

/**
 * A name a browser can safely save a file under: no path, no control characters, no quotes that
 * would break the Content-Disposition header. Falls back to a plain name rather than an empty one.
 */
export function safeAttachmentFilename(name: string | null | undefined): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  let cleaned = "";
  for (const character of base) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || character === '"') continue;
    cleaned += character;
  }
  cleaned = cleaned.trim().slice(0, 180);
  return cleaned || "attachment";
}

/**
 * Put inline images (`src="cid:…"`, a signature logo) back into the HTML as data URIs, so the reader
 * shows them without a second request. Capped: past the budget the reference is simply left, and the
 * image shows as missing rather than the reader carrying megabytes.
 */
export function embedInlineImages(
  html: string,
  images: Array<{ contentId: string | null; contentType: string | null; base64: string }>,
): string {
  let budget = MAX_INLINE_IMAGE_BYTES;
  let out = html;
  for (const image of images) {
    const id = (image.contentId ?? "").replace(/^<|>$/g, "").trim();
    if (!id || !image.contentType?.startsWith("image/")) continue;
    const size = Math.floor((image.base64.length * 3) / 4);
    if (size > budget) continue;
    const reference = `cid:${id}`;
    if (!out.includes(reference)) continue;
    budget -= size;
    out = out.split(reference).join(`data:${image.contentType};base64,${image.base64}`);
  }
  return out;
}

/**
 * The document the reader's sandboxed iframe renders. The iframe carries no allow-scripts and no
 * allow-same-origin, so nothing in a received email can run or reach Phoenix; the base target makes
 * a clicked link open a new tab instead of navigating inside the frame. no-referrer keeps a remote
 * image from learning the Phoenix address it was opened on, and the width caps keep a fixed-width
 * newsletter from scrolling sideways.
 */
export function readerDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank"><style>body{margin:12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111;background:#fff;word-wrap:break-word;overflow-wrap:anywhere}img,table,td,th,div,p{max-width:100%!important;box-sizing:border-box}img{height:auto}pre{white-space:pre-wrap}</style></head><body>${html}</body></html>`;
}

/**
 * The Content-Disposition for a downloaded attachment: always `attachment`, so a received HTML or
 * SVG file is saved rather than rendered on Phoenix's own origin. An ASCII fallback for old clients,
 * and the real name (Arabic included) in the RFC 5987 form every current browser reads.
 */
export function attachmentDisposition(name: string | null | undefined): string {
  const filename = safeAttachmentFilename(name);
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/[\\"]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Message-IDs sent back with a reply (In-Reply-To, References). Only the `<id@host>` form is kept,
 * so nothing a browser posts can smuggle a header line into the outgoing email.
 */
export function parseMessageIdList(raw: string | null | undefined): string[] {
  const ids: string[] = [];
  for (const part of (raw ?? "").split(/\s+/)) {
    if (/^<[^<>\s]{1,250}>$/.test(part) && !ids.includes(part)) ids.push(part);
  }
  return ids.slice(-20);
}

/** Where the envelope last stood in someone's inbox. Kept in that person's own browser. */
export type MailAlertBaseline = { uidValidity: string; watermark: number };

/** Read a stored baseline back; anything malformed is no baseline (and so announces nothing). */
export function parseMailAlertBaseline(raw: string | null | undefined): MailAlertBaseline | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { uidValidity?: unknown; watermark?: unknown };
    if (typeof value.uidValidity !== "string" || !value.uidValidity) return null;
    if (typeof value.watermark !== "number" || !Number.isInteger(value.watermark) || value.watermark < 0) return null;
    return { uidValidity: value.uidValidity, watermark: value.watermark };
  } catch {
    return null;
  }
}

/**
 * Which unread emails arrived since the last look, newest first: the ones worth a pop-up. The first
 * look announces nothing (no baseline yet, or a folder Turbify renumbered), because two thousand old
 * unread emails are not news. The watermark only ever moves forward, so one email is announced once.
 */
export function newUnreadSince(
  baseline: MailAlertBaseline | null,
  status: { uidValidity: string; watermark: number; newestUnread: PersonalMailboxAlertItem[] },
): { fresh: PersonalMailboxAlertItem[]; next: MailAlertBaseline } {
  if (baseline === null || baseline.uidValidity !== status.uidValidity) {
    return { fresh: [], next: { uidValidity: status.uidValidity, watermark: status.watermark } };
  }
  const fresh = status.newestUnread
    .filter((item) => item.uid >= baseline.watermark)
    .sort((a, b) => b.uid - a.uid);
  return {
    fresh,
    next: { uidValidity: status.uidValidity, watermark: Math.max(baseline.watermark, status.watermark) },
  };
}

/** The envelope badge: the exact count up to 99, then "99+". No unread email shows no badge. */
export function unreadBadgeLabel(count: number | null | undefined): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count < 1) return null;
  return count > 99 ? "99+" : String(Math.floor(count));
}

/** The pop-up's words for newly arrived email: sender and subject in full, never shortened. */
export function newMailAlertText(fresh: PersonalMailboxAlertItem[]): { title: string; body: string } | null {
  const latest = fresh[0];
  if (!latest) return null;
  const sender = latest.fromName?.trim() || latest.fromAddress?.trim() || "Unknown sender";
  const subject = latest.subject?.trim() || "(no subject)";
  if (fresh.length === 1) return { body: subject, title: `New email from ${sender}` };
  // A check brings back at most PERSONAL_MAILBOX_ALERT_LIMIT, so a full list may be the top of more.
  const count = fresh.length >= PERSONAL_MAILBOX_ALERT_LIMIT ? `${PERSONAL_MAILBOX_ALERT_LIMIT} or more` : String(fresh.length);
  return { body: `Latest from ${sender}: ${subject}`, title: `${count} new emails` };
}
