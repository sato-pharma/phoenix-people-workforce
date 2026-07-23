
import { phoenixEmailSignatureHostedUrl } from "@/emails/phoenix-email-layout";
import { isForceTestingDelivery, isProductionRuntime, systemEmail, systemIdentity } from "@/config/system-settings";
import { assertReachableEmailImage, isNonDeliverableEmail } from "@/lib/email/email-safety";
import {
  resolveEmailProviders,
  sendPreparedEmailWithFailover,
  type PreparedEmail,
} from "@/lib/email/email-providers";
import {
  evaluateAndRecordNotificationSend,
  markNotificationSendDelivered,
  type NotificationOrigin,
} from "@/lib/notifications/confidence-gate";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Re-exported for back-compat: existing callers/tests import these from this module.
export { parseRetryAfter, RetryableEmailError } from "@/lib/email/email-errors";

export type SendPhoenixEmailAttachment = {
  /** Base64-encoded file content. */
  content: string;
  contentType?: string;
  filename: string;
};

export type SendPhoenixEmailInput = {
  attachments?: SendPhoenixEmailAttachment[];
  bcc?: string[];
  /**
   * Internal use only, set exclusively by confidence-gate.ts's approveHeldNotification when
   * a Super Admin manually approves a held item — never set this from domain code. Skips the
   * Notification Confidence Gate for this one already-human-reviewed send.
   */
  bypassConfidenceGate?: boolean;
  cc?: string[];
  /**
   * When true and the resolved `to` has more than one recipient, move them to BCC behind
   * a neutral visible To. Prevents a multi-recipient fan-out (manager chain, HR inbox,
   * selected titles) from exposing every recipient's address to the others.
   */
  fanoutToBcc?: boolean;
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
  return assertReachableEmailImage(url, { blockLocalAssets: true });
}

async function loadSuppressedRecipients(emails: string[]): Promise<Set<string>> {
  const suppressed = new Set<string>();
  if (emails.length === 0) return suppressed;
  const normalized = emails.map((e) => e.trim().toLowerCase());
  try {
    const supabase = getSupabaseAdmin();
    // O(1)-per-address lookup against the durable suppression list (PK on address),
    // honouring expiry (soft bounces auto-recover).
    const { data, error } = await supabase
      .from("email_suppressions")
      .select("address,expires_at")
      .in("address", normalized);
    if (error) throw error;
    const now = Date.now();
    for (const row of (data ?? []) as Array<{ address: string; expires_at: string | null }>) {
      const active = !row.expires_at || Date.parse(row.expires_at) > now;
      if (active) suppressed.add(row.address.trim().toLowerCase());
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

export async function sendPhoenixEmail(input: SendPhoenixEmailInput): Promise<SendPhoenixEmailResult> {
  if (!emailNotificationsEnabled()) {
    return { reason: "EMAIL_NOTIFICATIONS_ENABLED is not true.", skipped: true };
  }

  const from = input.from || process.env.NOTIFICATION_EMAIL_FROM || `${systemIdentity.appName} <${systemEmail.defaultFromEmail}>`;

  // Skip (don't retry) only when NO provider can send at all — with a backup configured, a
  // missing primary key just fails over instead of dropping the mail.
  if (!resolveEmailProviders().some((provider) => provider.isConfigured())) {
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
  const suppressed = await loadSuppressedRecipients(allCandidates);

  const to = removeSuppressed(baseTo, suppressed);
  if (to.length === 0) {
    return { reason: "All recipients are suppressed (bounce/complaint).", skipped: true };
  }
  let cc = testingRecipients ? undefined : input.cc && input.cc.length > 0 ? removeSuppressed(removeNonDeliverable(input.cc), suppressed) : undefined;
  let bcc = testingRecipients ? undefined : input.bcc && input.bcc.length > 0 ? removeSuppressed(removeNonDeliverable(input.bcc), suppressed) : undefined;

  const resolvedReplyTo = input.replyTo || process.env.NOTIFICATION_REPLY_TO || systemEmail.defaultReplyTo;

  let finalTo = to;
  // Privacy: a multi-recipient fan-out must not expose every recipient to the others.
  // Move them to BCC behind a neutral visible To (never in testing-redirect mode).
  if (input.fanoutToBcc && !testingRecipients && finalTo.length > 1) {
    bcc = Array.from(new Set([...finalTo, ...(bcc ?? [])]));
    cc = undefined;
    finalTo = [resolvedReplyTo];
  }

  // Always BCC omar.anwar@satopharma.com on every automated system email (all modules, all
  // types) - a standing copy of outbound HR/workflow mail, invisible to other recipients.
  if (!testingRecipients) {
    const alwaysBcc = "omar.anwar@satopharma.com";
    bcc = bcc ? [...new Set([...bcc, alwaysBcc])] : [alwaysBcc];
  }

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
      bcc: prepared.bcc,
      cc: prepared.cc,
      html: prepared.html,
      idempotencyKey: prepared.idempotencyKey,
      origin: input.origin ?? null,
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
  const delivered = await sendPreparedEmailWithFailover(prepared);
  await markNotificationSendDelivered(reviewId, delivered.id);
  return { id: delivered.id, skipped: false };
}
