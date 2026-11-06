
import {
  isRecipientPreferenceSuppression,
  isTransactionalEmailType,
  shouldMirrorEmailToAdminTelegram,
  type CredentialEmailKind,
} from "@/lib/email/transactional-types";
import { phoenixEmailSignatureHostedUrl } from "@/emails/phoenix-email-layout";
import { isForceTestingDelivery, isProductionRuntime, systemEmail, systemIdentity } from "@/config/system-settings";
import { assertReachableEmailImage, isNonDeliverableEmail } from "@/lib/email/email-safety";
import { resolveReplyToAddress } from "@/lib/email/receivable-address";
import {
  resolveEmailProviders,
  sendPreparedEmailWithFailover,
  type EmailDispatch,
  type PreparedEmail,
} from "@/lib/email/email-providers";
import {
  evaluateAndRecordNotificationSend,
  markNotificationSendDelivered,
  type NotificationOrigin,
} from "@/lib/notifications/confidence-gate";
import {
  decideRecipientAssurance,
  resolveAssuranceDirectory,
  resolveSystemInboxes,
} from "@/lib/email/recipient-assurance";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { mirrorEmailToAdminTelegram } from "@/lib/email/admin-telegram-mirror";

// Re-exported for back-compat: existing callers/tests import these from this module.
export { parseRetryAfter, RetryableEmailError } from "@/lib/email/email-errors";

export type SendPhoenixEmailAttachment = {
  /** Base64-encoded file content. */
  content: string;
  /**
   * Content-ID for a part the HTML draws inline with `<img src="cid:…">` — a letterhead mark, a
   * seal. An inline part is carried BY the message, so it needs no permission to display: a remote
   * `https://` image is withheld by default in Outlook, Yahoo/Turbify webmail and Gmail until the
   * reader allows images for that sender, and that is what left the Sato mark as a torn-page
   * placeholder on sent offer letters (2026-09-17). Set `remoteUrl` beside it so a provider that
   * cannot carry a Content-ID still has somewhere to point the same `<img>`.
   */
  contentId?: string;
  contentType?: string;
  filename: string;
  /** Public https copy of the same file, for providers with no Content-ID support (Brevo). */
  remoteUrl?: string;
};

export type SendPhoenixEmailInput = {
  attachments?: SendPhoenixEmailAttachment[];
  /**
   * The notification type being sent. Only used to decide whether a recipient's own
   * unsubscribe may withhold this mail: transactional types (password reset / account setup)
   * are how somebody gets back into their account, so an unsubscribe from something else must
   * not block them. Hard bounces and complaints still suppress everything.
   */
  notificationType?: string | null;
  bcc?: string[];
  /**
   * Internal use only, set exclusively by confidence-gate.ts's approveHeldNotification when
   * a Super Admin manually approves a held item — never set this from domain code. Skips the
   * Notification Confidence Gate for this one already-human-reviewed send.
   */
  bypassConfidenceGate?: boolean;
  cc?: string[];
  /**
   * Addresses that legitimately belong to nobody in the employee directory — a job candidate, or
   * the sender of an inbound email being replied to. The Recipient Assurance Guard blocks any
   * unrecognised address, so an external send MUST declare its addresses here or it will not go
   * out. Required because the owner scoped the guard to all mail, recruitment included
   * (2026-08-08); without a declaration there is no way to tell an intended external recipient
   * from a typo or a stale hard-coded address.
   */
  externalRecipients?: string[];
  /**
   * When true and the resolved `to` has more than one recipient, move them to BCC behind
   * a neutral visible To. Prevents a multi-recipient fan-out (manager chain, HR inbox,
   * selected titles) from exposing every recipient's address to the others.
   */
  fanoutToBcc?: boolean;
  /**
   * The address that stands in the visible To of a fan-out, when it must NOT be the Reply-To.
   * Only the Sato Email Composer sets it: its replies go to the owner's mailbox while the mail
   * itself is the HR Business Partner's, and the To line every recipient reads stays hers.
   * Unset — every other sender — keeps the resolved Reply-To there, exactly as before.
   *
   * 🔴 Whatever is passed here is READ BY EVERY RECIPIENT and must be a deliverable mailbox that
   * Resend has not suppressed: a suppressed visible To is dropped, which is the 2026-09-13 bug.
   */
  fanoutVisibleTo?: string;
  from?: string;
  headers?: Record<string, string>;
  /**
   * Best-effort identifying context (module/eventType/recipient) for the Notification
   * Confidence Gate — powers the fan-out anomaly check and the /admin/notification-confidence
   * dashboard. The gate still runs and still records the send when this is omitted; it's just
   * bucketed as "unknown" and the fan-out check becomes not-applicable for that send.
   */
  origin?: NotificationOrigin | null;
  /**
   * Hand the prepared email to THIS instead of the provider chain. Set by one sender only: a job
   * offer, when the real `hr@` mailbox's app password is configured (`jobOfferSmtpDispatch()` in
   * `job-offer-smtp.ts`, owner 2026-11-06). Everything before the hand-off — suppression, the
   * Recipient Assurance Guard, the Confidence Gate — and the Telegram mirror after it are unchanged.
   * A failure it throws is the send's failure: there is no fall back to the chain.
   */
  dispatch?: EmailDispatch;
  /**
   * Set ONLY by a send whose body is a live credential (a reset code, a set-your-password link):
   * that email is not mirrored to the admin's Telegram (owner, 23 Oct 2026, "Skip credential emails").
   * Unset — every other email — keeps the mirror exactly as before. See CREDENTIAL_EMAIL_KINDS.
   */
  credentialEmail?: CredentialEmailKind | null;
  /**
   * Per-send Reply-To override. When unset, falls back to NOTIFICATION_REPLY_TO / the
   * system default reply-to. Lets a specific email type (e.g. job offers) route replies
   * to a dedicated inbox without changing every other email's reply-to.
   */
  replyTo?: string;
  html: string;
  idempotencyKey: string;
  subject: string;
  text: string;
  to: string[];
};

export type SendPhoenixEmailResult =
  | { id?: string; skipped?: false }
  | { reason: string; skipped: true };

// Resend caps total payload at ~40MB; keep a margin and also avoid Gmail's ~102KB body
// clipping by never letting attachments balloon the request unbounded.
const maxAttachmentBytes = 38 * 1024 * 1024;

/** Drop attachments that would exceed the total size budget (warn, never fail the send). */
export function guardAttachments(
  attachments: SendPhoenixEmailAttachment[] | undefined,
): SendPhoenixEmailAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  let total = 0;
  const kept: SendPhoenixEmailAttachment[] = [];
  for (const att of attachments) {
    const bytes = Math.ceil((att.content.length * 3) / 4); // base64 → bytes
    if (total + bytes > maxAttachmentBytes) {
      console.log("Email attachment exceeds size budget; dropped", {
        level: "warning",
        tags: { component: "email" },
        extra: { filename: att.filename, bytes },
      });
      continue;
    }
    total += bytes;
    kept.push(att);
  }
  return kept.length > 0 ? kept : undefined;
}

function emailNotificationsEnabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.EMAIL_NOTIFICATIONS_ENABLED ?? "").toLowerCase());
}

function splitEmailList(value: string | null | undefined) {
  return String(value ?? "")
    .split(/[,\n;]/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function resolveTestingRecipients() {
  const deliveryMode = String(process.env.PHOENIX_EMAIL_DELIVERY_MODE ?? "").trim().toLowerCase();
  const testRecipients = splitEmailList(process.env.PHOENIX_EMAIL_TEST_RECIPIENTS);
  // Redirect all mail to the testing recipients when the config safety switch is on
  // (isForceTestingDelivery()) OR the env delivery mode is explicitly "testing".
  const forceTesting = isForceTestingDelivery();
  const testingEnabled = forceTesting || deliveryMode === "testing";
  if (!testingEnabled) return null;
  const redirectTo =
    testRecipients.length > 0 ? Array.from(new Set(testRecipients)) : [...systemEmail.testingRecipientFallback];
  // A redirect previously fired silently and still returned a success {id}, which hid the
  // fact that real recipients never received mail. Always leave a breadcrumb, and in
  // production raise a warning (a redirect in prod almost always means a forgotten
  // PHOENIX_EMAIL_FORCE_TESTING=false and real employees/candidates are not being reached).

  if (isProductionRuntime()) {
    console.log("Email redirected to testing recipients in production", {
      level: "warning",
      tags: { component: "email", redirect: "testing" },
      extra: { reason: forceTesting ? "force_testing" : "delivery_mode" },
    });
  }
  return redirectTo;
}

export async function assertReachablePhoenixEmailImage(url = phoenixEmailSignatureHostedUrl) {
  // `skipReservedTestHosts` covers the stub loaders: under them `phoenixEmailSignatureHostedUrl`
  // is an example.com / example.invalid placeholder, and fetching it logged a 404 that read like
  // the real signature had gone missing from the mail. The live hosted URL is unaffected — it is
  // still fetched, and still warns if it ever stops serving an image.
  return assertReachableEmailImage(url, { blockLocalAssets: true, skipReservedTestHosts: true });
}

async function loadSuppressedRecipients(
  emails: string[],
  options?: { notificationType?: string | null },
): Promise<Set<string>> {
  const suppressed = new Set<string>();
  if (emails.length === 0) return suppressed;
  const normalized = emails.map((e) => e.trim().toLowerCase());
  // A transactional email is how somebody gets back INTO their account. An unsubscribe from
  // something else must not withhold it — the unsubscribe page explicitly promises "You will
  // still receive account and security emails", and before this it was not true: one click on
  // a birthday or SLA mail permanently blocked that person's password-reset link.
  //
  // Hard bounces and complaints still suppress everything, transactional included: those are
  // the provider telling us the address is undeliverable or that we are burning our sending
  // reputation, not a preference the recipient expressed.
  const transactional = isTransactionalEmailType(options?.notificationType);
  try {
    const supabase = getSupabaseAdmin();
    // O(1)-per-address lookup against the durable suppression list (PK on address),
    // honouring expiry (soft bounces auto-recover).
    const { data, error } = await supabase
      .from("email_suppressions")
      .select("address,expires_at,reason")
      .in("address", normalized);
    if (error) throw error;
    const now = Date.now();
    for (const row of (data ?? []) as Array<{ address: string; expires_at: string | null; reason: string | null }>) {
      const active = !row.expires_at || Date.parse(row.expires_at) > now;
      if (!active) continue;
      if (transactional && isRecipientPreferenceSuppression(row.reason)) continue;
      suppressed.add(row.address.trim().toLowerCase());
    }
    return suppressed;
  } catch {
    // FAIL-CLOSED for complaints: even if the suppression table is unavailable, never
    // re-email an address with a recorded complaint (spam-trap / reputation damage).
    // Soft/transient bounces fail-open (they may be temporary). This is the only
    // fail-open path, and only after the durable lookup itself fails.
    return loadComplaintSuppressionsFromEvents(normalized);
  }
}

async function loadComplaintSuppressionsFromEvents(normalized: string[]): Promise<Set<string>> {
  const suppressed = new Set<string>();
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("email_delivery_events")
      .select("recipients")
      .eq("status", "complained")
      .overlaps("recipients", normalized);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ recipients: string[] }>) {
      for (const r of row.recipients ?? []) {
        const lc = r.trim().toLowerCase();
        if (normalized.includes(lc)) suppressed.add(lc);
      }
    }
  } catch {
    /* both lookups failed — return what we have (possibly empty) */
  }
  return suppressed;
}

function removeSuppressed(emails: string[], suppressed: Set<string>): string[] {
  return emails.filter((e) => !suppressed.has(e.trim().toLowerCase()));
}

/**
 * Defense-in-depth: drop synthetic / non-routable addresses (e.g. the Supabase-auth
 * identity `phx-<hex>@auth.phoenix.local`) BEFORE they reach the provider, so no recipient
 * resolution mistake can ever hard-bounce a fake address and erode domain reputation.
 */
function removeNonDeliverable(emails: string[]): string[] {
  return emails.filter((e) => !isNonDeliverableEmail(e));
}

/**
 * The skip reason when the Recipient Assurance Guard cannot run. Worded so classifyOutboxSkip reads it
 * as TRANSIENT (it matches none of the terminal phrases), so a queued email is retried, never closed.
 */
export const RECIPIENT_ASSURANCE_UNAVAILABLE_REASON =
  "Recipient check unavailable — the employee directory could not be read, so the email was held back and will be retried.";

export async function sendPhoenixEmail(input: SendPhoenixEmailInput): Promise<SendPhoenixEmailResult> {
  if (!emailNotificationsEnabled()) {
    return { reason: "EMAIL_NOTIFICATIONS_ENABLED is not true.", skipped: true };
  }

  const from = input.from || process.env.NOTIFICATION_EMAIL_FROM || `${systemIdentity.appName} <${systemEmail.defaultFromEmail}>`;

  // Skip (don't retry) only when NO provider can send at all — with a backup configured, a
  // missing primary key just fails over instead of dropping the mail. A caller's own `dispatch`
  // does not need the chain, so its absence is no reason to skip.
  if (!input.dispatch && !resolveEmailProviders().some((provider) => provider.isConfigured())) {
    return { reason: "No email provider is configured (set RESEND_API_KEY, or BREVO_API_KEY for the backup).", skipped: true };
  }
  if (!from) return { reason: "Email sender is missing.", skipped: true };

  // The hosted signature image is cosmetic. Its reachability must NEVER block a send
  // (a brief outage previously failed every email, including password-reset links).
  try {
    await assertReachablePhoenixEmailImage();
  } catch (imageError) {
    console.log("Signature image unreachable; sending email anyway", {
      level: "warning",
      tags: { component: "email" },
      extra: { reason: imageError instanceof Error ? imageError.message : "unknown" },
    });
  }
  const testingRecipients = resolveTestingRecipients();

  // Drop synthetic / non-routable addresses up front. If every recipient was synthetic (an
  // employee with no real mailbox on file), this is a deterministic skip — never a send.
  const baseTo = removeNonDeliverable(testingRecipients ?? input.to);
  if (baseTo.length === 0) {
    return { reason: "No deliverable recipient (no real mailbox on file).", skipped: true };
  }

  const allCandidates = [...baseTo, ...(input.cc ?? []), ...(input.bcc ?? [])];
  const suppressed = await loadSuppressedRecipients(allCandidates, { notificationType: input.notificationType });

  const to = removeSuppressed(baseTo, suppressed);
  if (to.length === 0) {
    return { reason: "All recipients are suppressed (bounce/complaint).", skipped: true };
  }
  let cc = testingRecipients ? undefined : input.cc && input.cc.length > 0 ? removeSuppressed(removeNonDeliverable(input.cc), suppressed) : undefined;
  let bcc = testingRecipients ? undefined : input.bcc && input.bcc.length > 0 ? removeSuppressed(removeNonDeliverable(input.bcc), suppressed) : undefined;

  // Never the sending subdomain: it has no mailboxes, so a reply to it bounces (receivable-address.ts).
  const resolvedReplyTo = resolveReplyToAddress(input.replyTo);

  let finalTo = to;

  // ── Recipient Assurance Guard ────────────────────────────────────────────────────────────────
  // Runs on the REAL recipient list, deliberately before the fanoutToBcc transform below: that
  // transform replaces To with the neutral reply-to for privacy, so checking after it would see a
  // shared inbox in To and "correct" it by undoing the fan-out — trading a delivery bug for a
  // privacy leak. Skipped entirely in testing-redirect mode (recipients are the test inboxes by
  // design) and for a Super Admin's manual re-send of already-reviewed held content.
  if (!testingRecipients && !input.bypassConfidenceGate) {
    try {
      const decision = decideRecipientAssurance(
        {
          bcc,
          cc,
          chosenMailbox: input.origin?.chosenMailbox ?? null,
          declaredExternal: input.externalRecipients,
          intendedHrId: input.origin?.recipientHrId ?? null,
          systemInboxes: resolveSystemInboxes(),
          to: finalTo,
        },
        await resolveAssuranceDirectory(),
      );

      if (decision.outcome === "block") {
        logError("Recipient Assurance Guard blocked an email", {
          labels: {
            code: decision.code,
            event: "recipient_assurance_blocked",
            eventType: input.origin?.eventType ?? "unknown",
            module: input.origin?.module ?? "unknown",
            recipientHrId: input.origin?.recipientHrId ?? "",
          },
        });
        return { reason: `Blocked before sending — ${decision.reason}`, skipped: true };
      }

      if (decision.outcome === "corrected") {
        // Not silent: a correction means something upstream resolved the wrong recipient, and the
        // email only looks right because this guard rewrote it. That upstream bug still needs
        // fixing, so it is surfaced rather than absorbed.
        logError("Recipient Assurance Guard corrected the To address", {
          labels: {
            event: "recipient_assurance_corrected",
            eventType: input.origin?.eventType ?? "unknown",
            module: input.origin?.module ?? "unknown",
            recipientHrId: input.origin?.recipientHrId ?? "",
          },
          context: { correction: decision.correction },
        });
      }

      finalTo = decision.to;
    } catch (assuranceError) {
      // FAILS CLOSED (23 Oct 2026 audit, Pass 5). This used to send UNGUARDED whenever the guard
      // threw. A short directory outage is now covered by the last good copy of the directory
      // (resolveAssuranceDirectory keeps one for 24 hours), so reaching here means the guard truly
      // cannot check the recipients — and an email to an unchecked address is the incident the guard
      // exists to prevent. Not sent; the reason is a transient one, so an outbox row is retried on its
      // normal schedule rather than closed.
      logError("Recipient Assurance Guard could not run — email held back, not sent", {
        error: assuranceError,
        labels: { event: "recipient_assurance_unavailable", module: input.origin?.module ?? "unknown" },
      });
      return { reason: RECIPIENT_ASSURANCE_UNAVAILABLE_REASON, skipped: true };
    }
  }
  // Privacy: a multi-recipient fan-out must not expose every recipient to the others.
  // Move them to BCC behind a neutral visible To (never in testing-redirect mode).
  if (input.fanoutToBcc && !testingRecipients && finalTo.length > 1) {
    bcc = Array.from(new Set([...finalTo, ...(bcc ?? [])]));
    cc = undefined;
    // The Reply-To is the default stand-in, and stays so for every sender that names no other.
    // A caller whose replies go somewhere other than its own mailbox passes fanoutVisibleTo, so
    // the address recipients READ and the address their Reply button USES can differ on purpose.
    finalTo = [input.fanoutVisibleTo?.trim() || resolvedReplyTo];
  }

  // 🔴 NO STANDING ADMIN BCC (owner, 2026-11-06: "Stop the BCC copies"). Until then every automated
  // email was blind-copied to the owner's mailbox — about 8,000 a month landing in his Yahoo-hosted
  // inbox, which junked most of them and so taught Yahoo that satopharma.com mail is junk. The BCC
  // is exactly what the caller asked for and nothing more. His copy of every email is the Telegram
  // mirror below, which stays; a notice ADDRESSED to him (To or CC) is unaffected.

  const emailHeaders = input.headers && Object.keys(input.headers).length > 0 ? input.headers : undefined;
  const attachments = guardAttachments(input.attachments);

  const prepared: PreparedEmail = {
    attachments,
    bcc,
    cc,
    from,
    headers: emailHeaders,
    html: input.html,
    idempotencyKey: input.idempotencyKey,
    // Only picks a dedicated per-module sending account (module-sending-accounts.ts).
    module: input.origin?.module ?? null,
    replyTo: resolvedReplyTo,
    subject: input.subject,
    text: input.text,
    to: finalTo,
  };

  // Notification Confidence Gate: every automated email passes through here — this is the
  // one function every send path (createSystemNotification, sendTemplatedEmail, and every
  // domain module that calls sendPhoenixEmail directly) ends up calling, with zero exceptions
  // found when tracing the full call graph. A failing check holds the send outright instead of
  // dispatching it; see confidence-gate.ts for the checks and /admin/notification-confidence
  // for the review queue. bypassConfidenceGate is set only by a Super Admin's manual approval
  // of an already-held, already-reviewed item — never by domain code.
  let reviewId: string | null = null;
  if (!input.bypassConfidenceGate) {
    const gate = await evaluateAndRecordNotificationSend({
      attachments: prepared.attachments,
      bcc: prepared.bcc,
      cc: prepared.cc,
      from: prepared.from,
      html: prepared.html,
      idempotencyKey: prepared.idempotencyKey,
      origin: input.origin ?? null,
      replyTo: prepared.replyTo,
      subject: prepared.subject,
      text: prepared.text,
      to: prepared.to,
    });
    reviewId = gate.reviewId;
    if (gate.decision === "hold") {
      return {
        reason: `Held for Super Admin review (${gate.confidencePercent}% confidence) — see /admin/notification-confidence.`,
        skipped: true,
      };
    }
  }

  // Dispatch through the provider-failover layer: Resend primary, plus an optional independent
  // backup (Brevo) used ONLY when Resend deterministically did not send (quota/auth). Ambiguous
  // errors never cross providers, so a send can never be duplicated. See email-providers.ts.
  // A caller-supplied `dispatch` (a job offer through the real hr@ mailbox) replaces the chain
  // outright — its failure is this send's failure, never a reason to try Resend instead.
  const delivered = input.dispatch ? await input.dispatch(prepared) : await sendPreparedEmailWithFailover(prepared);
  await markNotificationSendDelivered(reviewId, delivered.id);

  // The standing admin's copy of every automated email: mirror this just-dispatched email to his
  // Telegram. Since the standing BCC stopped (owner, 2026-11-06) this is the ONLY copy he gets of mail
  // not addressed to him, so it stays on every path — the job offer's Turbify dispatch included.
  // Fire-and-forget and best-effort — never awaited into the email result and unable to throw (see
  // the module). No mirror when redirecting to test inboxes, and none for an email whose send is
  // stamped as a credential (owner, 23 Oct 2026, "Skip credential emails").
  if (shouldMirrorEmailToAdminTelegram({ credentialEmail: input.credentialEmail, testingRedirectActive: Boolean(testingRecipients) })) {
    void mirrorEmailToAdminTelegram({
      cc: prepared.cc,
      html: prepared.html,
      subject: prepared.subject,
      text: prepared.text,
      to: prepared.to,
    });
  }

  return { id: delivered.id, skipped: false };
}
