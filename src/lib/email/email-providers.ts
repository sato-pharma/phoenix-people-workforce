// Email provider failover.
//
// Resend is the PRIMARY sender. When it deterministically does NOT send (quota/429, auth),
// we fail over to an optional independent BACKUP provider (Brevo) so mail never stops. The
// hard rule that makes this safe against DUPLICATES:
//
//   • A cross-provider hand-off happens ONLY on a "definitely not sent" signal (429/401/402/403),
//     or when the primary ACCEPTED the message and then reported it `failed` (checkAccepted).
//   • An AMBIGUOUS failure (network / timeout / 5xx — the send MIGHT have gone out) NEVER fails
//     over. It is retried on the SAME provider via the outbox, whose per-email dedupe + the
//     provider idempotency key prevent a double send.
//   • The outbox row is the single unit of work; a row marked `sent` is never re-processed.
//
// The layer is INERT until the backup is configured (BREVO_API_KEY): with only Resend present it
// behaves exactly as before — a 429 becomes a RetryableEmailError the outbox retries later.
//
// EXTRA ACCOUNTS (owner, 2026-10-08 — Resend's daily quota runs out every day; a fourth Resend
// account added 2026-10-11): a second, third and fourth Resend account and a second Brevo account
// join the chain the moment their key is set, in this order:
//
//   resend → resend-2 (RESEND_API_KEY_2) → resend-3 (RESEND_API_KEY_3) → resend-4 (RESEND_API_KEY_4)
//     → brevo (BREVO_API_KEY) → brevo-2 (BREVO_API_KEY_2)
//
// Each extra account may send from its own verified address (RESEND_EMAIL_FROM_<n> /
// BREVO_EMAIL_FROM_2), because one sending domain can be verified in only one Resend account. Every
// hand-off between them obeys the same duplicate-safe rules above — a quota refusal or an
// accepted-then-failed message moves on, an ambiguous failure never does.
//
// PER-MODULE ACCOUNTS (owner, 2026-10-13 — sales first): a module's own Resend account, named by a
// suffix such as RESEND_API_KEY_SALES rather than a number, is tried FIRST for that module's mail
// and is never part of the pool above, so only that module can spend its quota. The registry is
// `module-sending-accounts.ts`; `resolveEmailProviders` puts the account in front of the chain.
//
// ONE message type is exempt from that sender override: a JOB OFFER, which by the owner's rule of
// 2026-10-13 fires from `HR@satopharma.com` or `hr@send.satopharma.com` and from nothing else. An
// account that would have to rewrite its From declines the offer instead of re-branding it, so the
// letter waits for the account that can send it as HR (`senderOverrideRefusal`).

import { RetryableEmailError, parseRetryAfter } from "@/lib/email/email-errors";
import { splitAddressList } from "@/lib/email/receivable-address";
import { JOB_OFFER_SENDER_ADDRESSES, isJobOfferSender } from "@/lib/email/job-offer-sender";
import { isSatoIdentitySender } from "@/lib/email/sato-identity-senders";
import { moduleSendingAccountFor, moduleSendingAccounts, type ModuleSendingAccount } from "@/lib/email/module-sending-accounts";

export type PreparedEmailAttachment = {
  content: string;
  /** Set when the HTML draws this part inline with `<img src="cid:…">`. */
  contentId?: string;
  contentType?: string;
  filename: string;
  /** Public https copy, used by a provider that cannot carry a Content-ID. */
  remoteUrl?: string;
};

export type PreparedEmail = {
  attachments?: PreparedEmailAttachment[];
  bcc?: string[];
  cc?: string[];
  from: string;
  headers?: Record<string, string>;
  html: string;
  idempotencyKey: string;
  /**
   * The module this email belongs to (`origin.module`: "sales", a template category such as "Sales").
   * It only picks a dedicated sending account (`module-sending-accounts.ts`); unset or unknown
   * keeps the ordinary chain, byte for byte.
   */
  module?: string | null;
  replyTo: string;
  subject: string;
  text: string;
  to: string[];
};

// Coarse per-attempt outcome, deliberately provider-agnostic so Resend and Brevo classify errors
// the same way and the orchestrator can reason about them uniformly.
export type ProviderSendResult =
  // Delivered — stop, record the message id.
  | { outcome: "sent"; id: string }
  // Deterministically NOT sent (quota/auth). Safe to try the next provider (no duplicate risk).
  | { outcome: "failover"; reason: string; retryAfterMs?: number }
  // Ambiguous (may have sent). Retry the SAME provider later — never fail over.
  | { outcome: "retry"; reason: string; retryAfterMs?: number }
  // Hard, deterministic rejection (bad payload). A different provider would reject it too.
  | { outcome: "error"; reason: string };

// What the provider says, moments after accepting a message, about whether it then went out.
//   failed  → the provider accepted the request but did NOT send it. Safe to hand to the backup:
//             the message never left, so there is nothing to duplicate.
//   settled → it left, or reached a state that is not ours to second-guess (bounced, suppressed).
//   pending → still queued when we stopped asking, or the provider could not be asked. Treated as
//             sent — the same answer every send got before this check existed.
export type AcceptedSendCheck = { state: "failed"; reason: string } | { state: "pending" } | { state: "settled" };

export type EmailProvider = {
  name: string;
  isConfigured(): boolean;
  send(email: PreparedEmail): Promise<ProviderSendResult>;
  /**
   * Optional. Asked only when a backup exists to hand the message to. Resend can answer 200 with
   * an id and then mark the message `failed` a moment later (2026-09-28: every Resend send from
   * 13:00 Cairo onward, a job offer among them), and the 200 alone reads exactly like a delivery.
   */
  checkAccepted?(id: string): Promise<AcceptedSendCheck>;
};

const resendEndpoint = "https://api.resend.com/emails";
const brevoEndpoint = "https://api.brevo.com/v3/smtp/email";
const providerTimeoutMs = 15000;

// Map a non-2xx HTTP status to the coarse outcome class.
//   429/401/402/403 → the request was rejected without sending → safe to fail over.
//   5xx             → server-side/ambiguous → retry the same provider (never fail over).
//   other 4xx       → deterministic hard rejection (bad payload) → terminal.
function classifyErrorStatus(status: number): "failover" | "retry" | "error" {
  if (status === 429 || status === 401 || status === 402 || status === 403) return "failover";
  if (status >= 500) return "retry";
  return "error";
}

/**
 * Resend's attachment shape. `content_id` is what turns a part into an INLINE image the HTML can
 * reach with `<img src="cid:…">`; without it Resend sends the same bytes as a plain file, and the
 * `cid:` reference in the body resolves to nothing.
 */
function resendAttachments(email: PreparedEmail) {
  return email.attachments?.map((att) => ({
    content: att.content,
    content_id: att.contentId,
    content_type: att.contentType,
    filename: att.filename,
  }));
}

/**
 * Brevo has no Content-ID field on `attachment`, so an inline part would arrive as a stray file
 * beside an offer letter whose letterhead still pointed at nothing. Degrade instead of breaking:
 * point the `<img>` back at the public https copy — i.e. exactly the behaviour before inlining —
 * and leave the bytes out of the message. Only the FAILOVER provider is affected; Resend, which
 * sends every offer in practice, carries the real inline part.
 */
export function brevoInlineFallback(email: PreparedEmail): {
  attachments: PreparedEmailAttachment[] | undefined;
  html: string;
} {
  const inline = email.attachments?.filter((att) => att.contentId) ?? [];
  if (inline.length === 0) return { attachments: email.attachments, html: email.html };

  let html = email.html;
  for (const att of inline) {
    // `cid:` values are our own slugs, so a literal split/join is safer here than building a
    // RegExp out of one.
    html = html.split(`cid:${att.contentId}`).join(att.remoteUrl ?? "");
  }
  const rest = email.attachments?.filter((att) => !att.contentId);
  return { attachments: rest && rest.length > 0 ? rest : undefined, html };
}

// Parse a "Name <email@x>" (or bare "email@x") sender into Brevo's structured shape.
function parseSender(from: string): { email: string; name?: string } {
  const match = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) return { email: match[2].trim(), name: match[1] || undefined };
  return { email: from.trim() };
}

/**
 * Resend's `reply_to` takes a STRING or an ARRAY of strings. A Reply-To that names two mailboxes
 * (a job offer routes replies to HR and to the owner) MUST go as an array — Resend does not split a
 * single comma-joined string, it would treat the whole value as one malformed address and drop it.
 * One address still goes as a plain string, so existing single-recipient sends are byte-identical.
 */
function resendReplyTo(value: string): string | string[] | undefined {
  const list = splitAddressList(value);
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : list;
}

// Resend's `last_event` values that mean "not decided yet". Anything else is a verdict.
const resendPendingEvents = new Set(["", "queued", "scheduled", "sent"]);

// How long to keep asking, in waits between reads: 3 s in all. A healthy Resend send reads
// `delivered` at the first read, so only a stuck or failed one uses the whole budget. Keep it
// short: the outbox drains up to 10 rows inside ONE 30 s step (scheduled-processing.ts), and the
// busiest five minutes of the week before this shipped queued 7.
export const resendAcceptedCheckDelaysMs = [1000, 2000];

/**
 * Ask Resend whether a message it accepted then went out.
 *
 * 🔴 A 200 from `POST /emails` is NOT a delivery. On 2026-09-28 Resend answered 200 with an id for
 * every send from 13:00 Cairo and marked 52 of the next 56 `failed` — a job offer among them — while
 * Phoenix recorded each as sent and never reached the backup, because the failover above only fires
 * on a REFUSED request. This read closes that: a `failed` verdict hands the message to Brevo.
 *
 * Read-only, and it never throws: any trouble asking (network, 429, a missing key) answers
 * `pending`, which keeps the pre-check behaviour — treat the accepted send as sent.
 */
export async function checkResendAccepted(
  id: string,
  options: {
    /** The key of the account that accepted the message — a Resend id is readable only by its own account. */
    apiKey?: string;
    delaysMs?: number[];
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<AcceptedSendCheck> {
  const apiKey = (options.apiKey ?? process.env.RESEND_API_KEY)?.trim();
  if (!apiKey || !id) return { state: "pending" };
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (const delay of options.delaysMs ?? resendAcceptedCheckDelaysMs) {
    await sleep(delay);
    let lastEvent = "";
    try {
      const response = await fetchImpl(`${resendEndpoint}/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        method: "GET",
        signal: AbortSignal.timeout(providerTimeoutMs),
      });
      if (!response.ok) return { state: "pending" };
      const payload = (await response.json().catch(() => null)) as { last_event?: string } | null;
      lastEvent = String(payload?.last_event ?? "").trim().toLowerCase();
    } catch {
      return { state: "pending" };
    }
    if (lastEvent === "failed") return { reason: "Resend accepted the message, then marked it failed.", state: "failed" };
    if (!resendPendingEvents.has(lastEvent)) return { state: "settled" };
  }
  return { state: "pending" };
}

/** The env name for one account: the bare name for the first account, `<NAME>_<n>` for the others. */
function accountEnvName(base: string, suffix: string | undefined) {
  return suffix ? `${base}_${suffix}` : base;
}

function readEnv(name: string) {
  return process.env[name]?.trim() || "";
}

/**
 * An extra account's sender override. A full `Name <address>` is used as written; a bare address
 * keeps the display name of the message's own From, so a job offer still reads as HR and a
 * notification still reads as Phoenix — only the verified address underneath changes.
 */
export function applySenderOverride(from: string, override: string | undefined): string {
  const value = override?.trim();
  if (!value) return from;
  if (value.includes("<")) return value;
  const { name } = parseSender(from);
  return name ? `${name} <${value}>` : value;
}

/**
 * The one message whose From an account may NOT rewrite: a job offer.
 *
 * Owner rule, 2026-10-13 — an offer fires from `HR@satopharma.com` or `hr@send.satopharma.com`,
 * and from nothing else (`job-offer-sender.ts`). Every override above exists because a sending
 * domain is verified in only ONE account, so a backup must put its own address on the envelope;
 * for an offer that is exactly the thing the rule forbids. Measured on production 2026-10-13, the
 * backups would have sent `Sato Pharma HR <phoenix@send2.satopharma.com>` and — on Brevo, which
 * overrides the whole header — `Phoenix Workforce <phoenix@send.satopharma.com>`.
 *
 * So the account declines the message instead of rewriting it: `failover`, which is the chain's
 * "deterministically not sent" signal, so the next account is tried and, if none can send as HR,
 * `sendPreparedEmailWithFailover` raises a RETRYABLE error. The offer is delayed until Resend's
 * first account (the only one holding both Sato domains) can take it — never re-branded.
 */
export function senderOverrideRefusal(
  email: PreparedEmail,
  override: string | undefined,
  label: string,
): ProviderSendResult | null {
  const rewritten = applySenderOverride(email.from, override);
  if (rewritten === email.from) return null;
  if (!isJobOfferSender(email.from) || isJobOfferSender(rewritten)) return null;
  return {
    outcome: "failover",
    reason: `${label} would have to send this job offer as ${rewritten} instead of ${email.from}; a job offer fires only from ${JOB_OFFER_SENDER_ADDRESSES.join(" or ")}.`,
  };
}

/** Extra accounts beyond the first, by env suffix: RESEND_API_KEY_2, _3 and _4, BREVO_API_KEY_2. */
export const extraResendAccountSuffixes = ["2", "3", "4"] as const;
export const extraBrevoAccountSuffixes = ["2"] as const;

type AccountLabel = { keyEnv: string; label: string };

function createResendProvider(suffix?: string, moduleAccount?: ModuleSendingAccount): EmailProvider {
  const keyEnv = accountEnvName("RESEND_API_KEY", suffix);
  // The first account keeps the message's own From, exactly as before; an extra account may send
  // from its own verified address.
  const fromEnv = suffix ? accountEnvName("RESEND_EMAIL_FROM", suffix) : null;
  const label = moduleAccount ? `Resend ${moduleAccount.label} account` : suffix ? `Resend account ${suffix}` : "Resend";
  return {
    name: moduleAccount ? `resend-${moduleAccount.suffix.toLowerCase()}` : suffix ? `resend-${suffix}` : "resend",
    isConfigured() {
      // A module account is switched on by its key AND its sender together. Without the sender it
      // would send as the message's own From, an address its domain does not hold, and Resend
      // would refuse every message — so it stays out of the chain instead of failing each send.
      if (moduleAccount) return Boolean(readEnv(keyEnv) && fromEnv && readEnv(fromEnv));
      return Boolean(readEnv(keyEnv));
    },
    checkAccepted(id) {
      return checkResendAccepted(id, { apiKey: readEnv(keyEnv) });
    },
    send(email) {
      const override = fromEnv ? readEnv(fromEnv) : "";
      // A job offer is never re-branded onto this account's own address — it waits for the one
      // that can send as HR (`senderOverrideRefusal`).
      const refusal = senderOverrideRefusal(email, override, label);
      if (refusal) return Promise.resolve(refusal);
      const from = applySenderOverride(email.from, override);
      return sendViaResend(email, { apiKey: readEnv(keyEnv), from, keyEnv, label });
    },
  };
}

async function sendViaResend(
  email: PreparedEmail,
  account: AccountLabel & { apiKey: string; from: string },
): Promise<ProviderSendResult> {
  const { apiKey } = account;
  if (!apiKey) return { outcome: "failover", reason: `${account.keyEnv} is missing.` };

  let response: Response;
  try {
    response = await fetch(resendEndpoint, {
      body: JSON.stringify({
        attachments: resendAttachments(email),
        bcc: email.bcc,
        cc: email.cc,
        from: account.from,
        headers: email.headers,
        html: email.html,
        // 🔴 `reply_to`, NOT `replyTo`. This is the raw REST API: only Resend's Node SDK maps the
        // camelCase name across. Resend does not reject `replyTo` — it drops it, answers 200 and
        // sends the mail with NO Reply-To header, so every reply to any Phoenix email went to the
        // From address on the sending subdomain, which has no mailbox, and bounced.
        // An array carries the several mailboxes a job offer replies to; a lone address stays a string.
        reply_to: resendReplyTo(email.replyTo),
        subject: email.subject,
        text: email.text,
        to: email.to,
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Resend dedupes retries with the same key — makes a same-provider retry safe.
        "Idempotency-Key": email.idempotencyKey,
      },
      method: "POST",
      signal: AbortSignal.timeout(providerTimeoutMs),
    });
  } catch (networkError) {
    // Network/timeout: the request may or may not have been delivered → ambiguous → retry same.
    return {
      outcome: "retry",
      reason: networkError instanceof Error ? `${account.label} request failed: ${networkError.message}` : `${account.label} request failed.`,
    };
  }

  const payload = (await response.json().catch(() => null)) as { error?: string; id?: string; message?: string } | null;

  if (response.ok) {
    if (!payload?.id) return { outcome: "error", reason: `${account.label} accepted the request without returning a message id.` };
    return { outcome: "sent", id: payload.id };
  }

  const reason = response.status === 429 ? `${account.label} rate limited (429).` : payload?.message ?? payload?.error ?? `${account.label} request failed with ${response.status}.`;
  return {
    outcome: classifyErrorStatus(response.status),
    reason,
    retryAfterMs: response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : undefined,
  };
}

export const resendProvider: EmailProvider = createResendProvider();

function createBrevoProvider(suffix?: string): EmailProvider {
  const keyEnv = accountEnvName("BREVO_API_KEY", suffix);
  const fromEnv = accountEnvName("BREVO_EMAIL_FROM", suffix);
  const label = suffix ? `Brevo account ${suffix}` : "Brevo";
  return {
    name: suffix ? `brevo-${suffix}` : "brevo",
    isConfigured() {
      return Boolean(readEnv(keyEnv));
    },
    send(email) {
      // Brevo's sender must be a verified sender/domain on THAT Brevo account. The first account
      // reads BREVO_EMAIL_FROM, else the message's own From — unchanged. An extra account reads its
      // own BREVO_EMAIL_FROM_<n>, then the first account's, then the message's own From.
      const override = readEnv(fromEnv) || (suffix ? readEnv("BREVO_EMAIL_FROM") : "");
      // A job offer is never re-branded onto a Brevo sender — this account's override is the one
      // that would have put *Phoenix Workforce* on an offer of employment.
      const refusal = senderOverrideRefusal(email, override, label);
      if (refusal) return Promise.resolve(refusal);
      return sendViaBrevo(email, { apiKey: readEnv(keyEnv), keyEnv, label, sender: parseSender(override || email.from) });
    },
  };
}

async function sendViaBrevo(
  email: PreparedEmail,
  account: AccountLabel & { apiKey: string; sender: { email: string; name?: string } },
): Promise<ProviderSendResult> {
  const { apiKey, sender } = account;
  if (!apiKey) return { outcome: "failover", reason: `${account.keyEnv} is missing.` };

  // Brevo cannot carry a Content-ID, so an inline image goes back to its public https copy here.
  const { attachments: brevoAttachments, html: brevoHtml } = brevoInlineFallback(email);

  // Brevo's transactional API takes a SINGLE replyTo object. When an offer routes replies to more
  // than one mailbox the primary (Resend, which sends every offer in practice) carries them all;
  // the backup can honour only the first, which is the HR inbox.
  const brevoReplyTo = splitAddressList(email.replyTo)[0];

  let response: Response;
  try {
    response = await fetch(brevoEndpoint, {
      body: JSON.stringify({
        sender,
        to: email.to.map((address) => ({ email: address })),
        cc: email.cc && email.cc.length > 0 ? email.cc.map((address) => ({ email: address })) : undefined,
        bcc: email.bcc && email.bcc.length > 0 ? email.bcc.map((address) => ({ email: address })) : undefined,
        subject: email.subject,
        htmlContent: brevoHtml,
        textContent: email.text,
        replyTo: brevoReplyTo ? { email: brevoReplyTo } : undefined,
        headers: email.headers,
        attachment:
          brevoAttachments && brevoAttachments.length > 0
            ? brevoAttachments.map((att) => ({ content: att.content, name: att.filename }))
            : undefined,
      }),
      headers: {
        accept: "application/json",
        "api-key": apiKey,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(providerTimeoutMs),
    });
  } catch (networkError) {
    return {
      outcome: "retry",
      reason: networkError instanceof Error ? `${account.label} request failed: ${networkError.message}` : `${account.label} request failed.`,
    };
  }

  const payload = (await response.json().catch(() => null)) as { message?: string; messageId?: string | number } | null;

  if (response.ok) {
    const id = payload?.messageId ? String(payload.messageId) : "";
    if (!id) return { outcome: "error", reason: `${account.label} accepted the request without returning a messageId.` };
    return { outcome: "sent", id };
  }

  const reason = response.status === 429 ? `${account.label} rate limited (429).` : payload?.message ?? `${account.label} request failed with ${response.status}.`;
  return {
    outcome: classifyErrorStatus(response.status),
    reason,
    retryAfterMs: response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : undefined,
  };
}

export const brevoProvider: EmailProvider = createBrevoProvider();

const extraResendProviders = extraResendAccountSuffixes.map((suffix) => createResendProvider(suffix));
const extraBrevoProviders = extraBrevoAccountSuffixes.map((suffix) => createBrevoProvider(suffix));

// The dedicated per-module accounts, by module-account suffix. Never part of the failover pool above.
const moduleResendProviders = new Map(
  moduleSendingAccounts.map((account) => [account.suffix, createResendProvider(account.suffix, account)] as const),
);

/** Every module account with whether it is switched on (names only, never a key) — for the health read-out. */
export function moduleSendingAccountStatus() {
  return moduleSendingAccounts.map((account) => ({
    configured: moduleResendProviders.get(account.suffix)?.isConfigured() ?? false,
    label: account.label,
    modules: [...account.modules],
    provider: moduleResendProviders.get(account.suffix)?.name ?? "",
  }));
}

// Ordered provider list: Resend primary, then every configured backup — the other Resend accounts
// first, then the Brevo accounts. A backup is skipped unless it is configured AND failover is not
// explicitly disabled — so with no backup env set this returns just [resend] and behaviour is
// unchanged.
//
// 🔴 THE FIRST ACCOUNT IS DEDICATED (owner, 2026-10-13: "make it and hrbp dedicated only for job
// offers + sato email composer"). It is the only account that can send as `hr@`, `hrbp@` or `ceo@`,
// and automated notification traffic was spending its ~100/day quota by lunchtime — 404 Resend
// messages on 11 Oct — which is why 30 of the last 63 offers were sent by a backup account and 18
// went out as *Phoenix Workforce*. So an ordinary Phoenix email is given the chain WITHOUT it, and
// mail from a Sato human identity keeps it (`sato-identity-senders.ts`). Passing no `email` returns
// the whole chain, which is what a "is any provider configured at all" check wants.
//
// 🔒 A MODULE ACCOUNT GOES IN FRONT (owner, 2026-10-13: one Resend account per module, sales first).
// An email whose `module` has a configured dedicated account tries it FIRST and then falls through
// to the ordinary chain, so a refused or capped module account never stops the mail. The module
// account is never in the ordinary chain, so no other module's mail can spend its quota. A Sato
// human identity (`hr@`, `hrbp@`, `ceo@`) is exempt: it keeps the first account whatever its module.
export function resolveEmailProviders(email?: Pick<PreparedEmail, "from"> & { module?: string | null }): EmailProvider[] {
  const providers: EmailProvider[] = [resendProvider];
  const failoverDisabled = String(process.env.EMAIL_FAILOVER_ENABLED ?? "").trim().toLowerCase() === "false";
  if (failoverDisabled) return providers;
  for (const backup of [...extraResendProviders, brevoProvider, ...extraBrevoProviders]) {
    if (backup.isConfigured()) providers.push(backup);
  }

  if (email && isSatoIdentitySender(email.from)) return providers;

  // Ordinary automated mail hands the dedicated account back — but only while something else can
  // carry it. With no backup configured (a local run, staging, a lapsed key) the chain stays as it
  // was: an email that cannot be sent at all is worse than one that spends the reserved quota.
  const ordinary = email && providers.length > 1 ? providers.slice(1) : providers;

  const moduleAccount = email ? moduleSendingAccountFor(email.module) : null;
  const moduleProvider = moduleAccount ? moduleResendProviders.get(moduleAccount.suffix) : undefined;
  if (moduleProvider?.isConfigured()) return [moduleProvider, ...ordinary];

  return ordinary;
}

export type FailoverSendResult = { id: string; provider: string };

/**
 * A replacement for the provider chain, for the ONE message that must not ride it: a job offer sent
 * through the real `hr@` mailbox on Turbify (`job-offer-smtp.ts`, owner 2026-11-06). Handed the same
 * prepared email the chain would get; it resolves once the message is accepted, or throws.
 */
export type EmailDispatch = (email: PreparedEmail) => Promise<FailoverSendResult>;

/**
 * Dispatch a prepared email through the provider chain with duplicate-safe failover.
 * `providers` is injectable for testing; production passes the env-resolved chain.
 */
export async function sendPreparedEmailWithFailover(
  email: PreparedEmail,
  providers: EmailProvider[] = resolveEmailProviders(email),
): Promise<FailoverSendResult> {
  let lastFailover: { reason: string; retryAfterMs?: number } | null = null;

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const result = await provider.send(email);

    if (result.outcome === "sent") {
      // Accepted is not sent. Resend stays the primary and the source of truth; Brevo is used only
      // when Resend did not send — and "accepted, then failed" is Resend not sending. Asked only
      // when there is a backup to hand the message to; with none, the accepted id is all we have.
      const hasBackup = index < providers.length - 1;
      if (hasBackup && provider.checkAccepted) {
        const check = await provider.checkAccepted(result.id);
        if (check.state === "failed") {
          console.log("Primary email provider accepted a message and then failed it; handing it to the backup", {
            level: "warning",
            tags: { component: "email", failover: "accepted_then_failed", provider: provider.name },
            extra: { primaryMessageId: result.id, reason: check.reason },
          });
          lastFailover = { reason: `${provider.name}: ${check.reason}` };
          continue;
        }
      }
      if (index > 0) {
        // Falling back to a backup means the primary was unavailable/exhausted — surface it so the
        // team notices Resend is capped, even though the email itself still went out.
        console.log("Email delivered via BACKUP provider after primary failover", {
          level: "warning",
          tags: { component: "email", failover: "true", provider: provider.name },
          extra: { primaryReason: lastFailover?.reason ?? null },
        });
      }
      return { id: result.id, provider: provider.name };
    }

    if (result.outcome === "retry") {
      // Ambiguous — the send may have gone out. NEVER try another provider (would risk a duplicate).
      // The outbox retries this same provider; its idempotency key makes that safe.
      throw new RetryableEmailError(`${provider.name}: ${result.reason}`, result.retryAfterMs);
    }

    if (result.outcome === "error") {
      // Deterministic hard rejection — a different provider would reject the same payload too.
      throw new Error(`${provider.name}: ${result.reason}`);
    }

    // outcome === "failover": deterministic NOT sent (quota/auth) → try the next provider.
    lastFailover = { reason: `${provider.name}: ${result.reason}`, retryAfterMs: result.retryAfterMs };
  }

  // Every provider was exhausted/unavailable. Retryable, so the outbox re-attempts once a quota
  // window resets — mail is delayed, never dropped.
  throw new RetryableEmailError(
    `All email providers unavailable: ${lastFailover?.reason ?? "no provider configured"}`,
    lastFailover?.retryAfterMs,
  );
}
