// Email provider failover.
//
// Resend is the PRIMARY sender. When it deterministically does NOT send (quota/429, auth),
// we fail over to an optional independent BACKUP provider (Brevo) so mail never stops. The
// hard rule that makes this safe against DUPLICATES:
//
//   • A cross-provider hand-off happens ONLY on a "definitely not sent" signal (429/401/402/403).
//   • An AMBIGUOUS failure (network / timeout / 5xx — the send MIGHT have gone out) NEVER fails
//     over. It is retried on the SAME provider via the outbox, whose per-email dedupe + the
//     provider idempotency key prevent a double send.
//   • The outbox row is the single unit of work; a row marked `sent` is never re-processed.
//
// The layer is INERT until the backup is configured (BREVO_API_KEY): with only Resend present it
// behaves exactly as before — a 429 becomes a RetryableEmailError the outbox retries later.

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

export type EmailProvider = {
  name: string;
  isConfigured(): boolean;
  send(email: PreparedEmail): Promise<ProviderSendResult>;
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

export const resendProvider: EmailProvider = {
  name: "resend",
  isConfigured() {
    return Boolean(process.env.RESEND_API_KEY?.trim());
  },
  async send(email) {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) return { outcome: "failover", reason: "RESEND_API_KEY is missing." };

    let response: Response;
    try {
      response = await fetch(resendEndpoint, {
        body: JSON.stringify({
          attachments: resendAttachments(email),
          bcc: email.bcc,
          cc: email.cc,
          from: email.from,
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
        reason: networkError instanceof Error ? `Resend request failed: ${networkError.message}` : "Resend request failed.",
      };
    }

    const payload = (await response.json().catch(() => null)) as { error?: string; id?: string; message?: string } | null;

    if (response.ok) {
      if (!payload?.id) return { outcome: "error", reason: "Resend accepted the request without returning a message id." };
      return { outcome: "sent", id: payload.id };
    }

    const reason = response.status === 429 ? "Resend rate limited (429)." : payload?.message ?? payload?.error ?? `Resend request failed with ${response.status}.`;
    return {
      outcome: classifyErrorStatus(response.status),
      reason,
      retryAfterMs: response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : undefined,
    };
  },
};

export const brevoProvider: EmailProvider = {
  name: "brevo",
  isConfigured() {
    return Boolean(process.env.BREVO_API_KEY?.trim());
  },
  async send(email) {
    const apiKey = process.env.BREVO_API_KEY?.trim();
    if (!apiKey) return { outcome: "failover", reason: "BREVO_API_KEY is missing." };

    // Brevo's sender must be a verified sender/domain on the Brevo account; allow a dedicated
    // BREVO_EMAIL_FROM override, else reuse the primary from-address.
    const sender = parseSender(process.env.BREVO_EMAIL_FROM?.trim() || email.from);

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
        reason: networkError instanceof Error ? `Brevo request failed: ${networkError.message}` : "Brevo request failed.",
      };
    }

    const payload = (await response.json().catch(() => null)) as { message?: string; messageId?: string | number } | null;

    if (response.ok) {
      const id = payload?.messageId ? String(payload.messageId) : "";
      if (!id) return { outcome: "error", reason: "Brevo accepted the request without returning a messageId." };
      return { outcome: "sent", id };
    }

    const reason = response.status === 429 ? "Brevo rate limited (429)." : payload?.message ?? `Brevo request failed with ${response.status}.`;
    return {
      outcome: classifyErrorStatus(response.status),
      reason,
      retryAfterMs: response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : undefined,
    };
  },
};

// Ordered provider list: Resend primary, then any configured backup. The backup is skipped
// entirely unless it is configured AND failover is not explicitly disabled — so with no backup
// env set this returns just [resend] and behaviour is unchanged.
export function resolveEmailProviders(): EmailProvider[] {
  const providers: EmailProvider[] = [resendProvider];
  const failoverDisabled = String(process.env.EMAIL_FAILOVER_ENABLED ?? "").trim().toLowerCase() === "false";
  if (!failoverDisabled && brevoProvider.isConfigured()) providers.push(brevoProvider);
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
