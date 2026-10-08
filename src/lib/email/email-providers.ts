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
// EXTRA ACCOUNTS (owner, 2026-10-08 — Resend's daily quota runs out every day): a second Resend
// account and a second Brevo account join the chain the moment their key is set, in this order:
//
//   resend (RESEND_API_KEY) → resend-2 (RESEND_API_KEY_2) → brevo (BREVO_API_KEY) → brevo-2 (BREVO_API_KEY_2)
//
// Each extra account may send from its own verified address (RESEND_EMAIL_FROM_2 /
// BREVO_EMAIL_FROM_2), because one sending domain can be verified in only one Resend account. Every
// hand-off between them obeys the same duplicate-safe rules above — a quota refusal or an
// accepted-then-failed message moves on, an ambiguous failure never does.

import { RetryableEmailError, parseRetryAfter } from "@/lib/email/email-errors";
import { splitAddressList } from "@/lib/email/receivable-address";

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

/** Extra accounts beyond the first, by env suffix: RESEND_API_KEY_2, BREVO_API_KEY_2. */
export const extraEmailAccountSuffixes = ["2"] as const;

type AccountLabel = { keyEnv: string; label: string };

function createResendProvider(suffix?: string): EmailProvider {
  const keyEnv = accountEnvName("RESEND_API_KEY", suffix);
  // The first account keeps the message's own From, exactly as before; an extra account may send
  // from its own verified address.
  const fromEnv = suffix ? accountEnvName("RESEND_EMAIL_FROM", suffix) : null;
  const label = suffix ? `Resend account ${suffix}` : "Resend";
  return {
    name: suffix ? `resend-${suffix}` : "resend",
    isConfigured() {
      return Boolean(readEnv(keyEnv));
    },
    checkAccepted(id) {
      return checkResendAccepted(id, { apiKey: readEnv(keyEnv) });
    },
    send(email) {
      const from = fromEnv ? applySenderOverride(email.from, readEnv(fromEnv)) : email.from;
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

const extraResendProviders = extraEmailAccountSuffixes.map((suffix) => createResendProvider(suffix));
const extraBrevoProviders = extraEmailAccountSuffixes.map((suffix) => createBrevoProvider(suffix));

// Ordered provider list: Resend primary, then every configured backup — the other Resend accounts
// first, then the Brevo accounts. A backup is skipped unless it is configured AND failover is not
// explicitly disabled — so with no backup env set this returns just [resend] and behaviour is
// unchanged.
export function resolveEmailProviders(): EmailProvider[] {
  const providers: EmailProvider[] = [resendProvider];
  const failoverDisabled = String(process.env.EMAIL_FAILOVER_ENABLED ?? "").trim().toLowerCase() === "false";
  if (failoverDisabled) return providers;
  for (const backup of [...extraResendProviders, brevoProvider, ...extraBrevoProviders]) {
    if (backup.isConfigured()) providers.push(backup);
  }
  return providers;
}

export type FailoverSendResult = { id: string; provider: string };

/**
 * Dispatch a prepared email through the provider chain with duplicate-safe failover.
 * `providers` is injectable for testing; production passes the env-resolved chain.
 */
export async function sendPreparedEmailWithFailover(
  email: PreparedEmail,
  providers: EmailProvider[] = resolveEmailProviders(),
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
