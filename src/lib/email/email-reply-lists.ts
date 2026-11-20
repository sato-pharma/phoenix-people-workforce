import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { invalidCommunicationEmails } from "@/lib/communication/metrics";
import {
  composerHtmlToText,
  interpolateComposerHtml,
  normalizeComposerBody,
  recordManualEmailSendAudit,
  resolveComposerRecipients,
  type ComposerPayload,
} from "@/lib/email/email-composer-service";
import { validateManualEmailRecipientPolicy } from "@/lib/email/email-safety";
import { buildPhoenixHrReplyEmail } from "@/lib/email/phoenix-hr-reply-template";
import {
  REPLY_BULK_GREETING_FALLBACK,
  REPLY_BULK_MAX_PER_EMAIL,
  countReplyBulkSources,
  normalizeReplyListKeys,
  replyBulkTypedAddresses,
  replyBulkVariableProblem,
  replyBulkVisibleTo,
  type ReplyBulkOutcome,
  type ReplyBulkSendResult,
  type ReplyBulkSummary,
} from "@/lib/email/email-reply-lists-rules";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { emailNotificationsEnabled } from "@/lib/notifications/email";
import { logError } from "@/lib/observability/log";
import {
  buildSatoEmailIdempotencyKey,
  buildSatoEmailSendPlan,
  type SatoEmailRecipient,
  type SatoEmailSendPlan,
} from "@/lib/sato-email/plan";
import { getSatoEmailListOptions, resolveSatoEmailAudience, type SatoEmailListOption } from "@/lib/sato-email/service";
import { satoTypedAddressPolicy } from "@/lib/sato-email/typed-policy";

/**
 * Distribution lists in the Email Reply Composer — a bulk send that keeps the Phoenix identity.
 *
 * Owner 2026-11-19, in his own words: "in this module add distrbution list to be able to send bulk
 * emails but with phx identity". Until then the lists belonged to the Sato and CEO composers alone
 * and this composer was "left alone" (his 2026-09-11 "the other one, leave it now"); this is him
 * lifting that for this screen.
 *
 * WHAT STAYS THE SAME AS A NORMAL REPLY: the Phoenix HR template (buildPhoenixHrReplyEmail), its
 * From (HR_REPLY_EMAIL_FROM / NOTIFICATION_EMAIL_FROM), the seat's Reply-To, the manual recipient
 * policy on every email, the audit row per email, and sendPhoenixEmail with every guard it runs.
 *
 * WHAT A LIST CHANGES:
 *  - The audience is resolved by the Sato composer's resolveSatoEmailAudience, never here — so there
 *    is still exactly one place in the codebase where a picked list becomes addresses, and a list
 *    that composer may not address (switched off, or all-employees) cannot be reached from here.
 *  - Everyone — list members and every chip in To, Cc and Bcc — goes in emails of 25, each person in
 *    Bcc behind ONE visible To (the Reply-To inbox), so nobody sees anybody else's address.
 *  - Variables are refused: an email that goes to 300 people cannot carry one person's name, and the
 *    single-send path fills them from the FIRST selected employee.
 *
 * 🔴 WHO MAY SEND TO A LIST: the Super Admin seat only (canSendReplyComposerToLists), checked on the
 * server in the options, preview and send routes. `communication` opens this composer, and the day
 * it is granted to an HR seat again it must not hand that seat a company-wide send button with it —
 * "a bulk-send button behind an HR seat is the standing never-fire-bulk-email rule" (hr-functions.ts).
 *
 * 🔴 MANUAL MAIL, SO NO `origin` AND NEVER `bypassConfidenceGate` — the same ruling and the same pin as
 * the Sato composer (tests/sato-email-lists-only-composer.test.ts §4, tests/email-reply-lists.test.ts).
 */

export {
  canSendReplyComposerToLists,
  isReplyBulkPayload,
} from "@/lib/email/email-reply-lists-rules";


export async function getReplyComposerListOptions(): Promise<{ lists: SatoEmailListOption[]; warning: string | null }> {
  try {
    return { lists: await getSatoEmailListOptions(), warning: null };
  } catch (error) {
    logError("Email Reply Composer could not read the distribution lists", { error });
    return { lists: [], warning: "The distribution lists could not be loaded." };
  }
}

/**
 * Everyone a list send reaches: the chips in To, Cc and Bcc plus every picked list, deduped by
 * address and cut into emails of 25. Whatever falls out of a list is reported, never dropped.
 */
async function resolveReplyBulkAudience(input: ComposerPayload): Promise<{
  listKeys: string[];
  plan: SatoEmailSendPlan;
  skipped: ReplyBulkSummary["skipped"];
  warnings: string[];
}> {
  const listKeys = normalizeReplyListKeys(input.listKeys);
  const [chips, lists] = await Promise.all([
    resolveComposerRecipients(input),
    resolveSatoEmailAudience({ emails: [], hrIds: [], listKeys }),
  ]);
  const chipRecipients: SatoEmailRecipient[] = [...chips.to, ...chips.cc, ...chips.bcc].map((item) => ({
    email: item.email,
    hrId: null,
    name: item.label,
    source: item.source,
  }));
  const plan = buildSatoEmailSendPlan([...chipRecipients, ...lists.recipients], REPLY_BULK_MAX_PER_EMAIL);
  return { listKeys, plan, skipped: lists.skipped, warnings: [...chips.warnings, ...lists.warnings] };
}

function renderReplyBulk(input: ComposerPayload, visibleTo: string, signatureImageSrc: string) {
  const normalized = normalizeComposerBody(input);
  // An empty context: the sanitizer still runs over the rich body, and any token is refused before
  // a send (replyBulkVariableProblem), so nothing here ever fills one person's details.
  const replyMessageHtml = interpolateComposerHtml(normalized.replyMessageHtml, {});
  const generated = buildPhoenixHrReplyEmail({
    cc: "",
    recipientName: normalized.recipientName || REPLY_BULK_GREETING_FALLBACK,
    replyMessage: replyMessageHtml ? composerHtmlToText(replyMessageHtml) || normalized.replyMessage : normalized.replyMessage,
    replyMessageHtml,
    senderName: normalized.senderName,
    signatureImageSrc,
    subject: normalized.subject,
    // What every copy shows: the one visible To, never the batch.
    to: visibleTo,
    tone: normalized.tone,
  });
  return { generated, normalized };
}

/** Problems that stop a list send before anything leaves. Empty when it may go. */
function replyBulkIssues(input: ComposerPayload, recipientCount: number) {
  const normalized = normalizeComposerBody(input);
  const issues: Array<{ code: string; message: string }> = [];
  if (recipientCount === 0) issues.push({ code: "missing_to", message: "The lists and recipients you picked reach nobody." });
  const variables = replyBulkVariableProblem(normalized.subject, normalized.replyMessage, normalized.replyMessageHtml, normalized.recipientName);
  if (variables) issues.push({ code: "bulk_variables", message: variables });
  const typed = satoTypedAddressPolicy(replyBulkTypedAddresses(input), normalized.externalJustification);
  if (typed.problem) {
    issues.push({ code: "external_justification_required", message: typed.problem.replace('under "Why outside addresses"', 'under "External recipient justification"') });
  }
  return { issues, outside: typed.outside };
}

export async function previewReplyBulk(input: ComposerPayload, signatureImageSrc: string, replyTo: string | undefined) {
  const visibleTo = replyBulkVisibleTo(replyTo);
  const audience = await resolveReplyBulkAudience(input);
  const { generated, normalized } = renderReplyBulk(input, visibleTo, signatureImageSrc);
  const { issues, outside } = replyBulkIssues(input, audience.plan.recipients.length);
  const bulk: ReplyBulkSummary = {
    emailCount: audience.plan.batches.length,
    listKeys: audience.listKeys,
    recipientCount: audience.plan.recipients.length,
    skipped: audience.skipped,
    sources: countReplyBulkSources(audience.plan.recipients),
    visibleTo,
  };

  return {
    bulk,
    html: generated.html,
    plainText: generated.plainText,
    recipientPolicy: {
      externalRecipients: outside,
      issues,
      maxRecipients: REPLY_BULK_MAX_PER_EMAIL,
      totalRecipients: audience.plan.recipients.length,
    },
    recipients: {
      bcc: [],
      cc: [],
      to: [{ email: visibleTo, label: visibleTo, source: "Shown in the To line of every copy" }],
      totalRecipients: audience.plan.recipients.length,
    },
    signatureImageWarning: null,
    subject: normalized.subject,
    warnings: [
      ...audience.warnings,
      ...issues.map((issue) => issue.message),
      ...(normalized.subject ? [] : ["Subject is required before sending."]),
      ...(normalized.replyMessage ? [] : ["Message body is required before sending."]),
    ],
  };
}

export async function sendReplyBulk(input: {
  access: AccessContext;
  body: ComposerPayload;
  from: string;
  replyTo: string | undefined;
  signatureImageSrc: string;
}): Promise<ReplyBulkSendResult> {
  const { access, body, from, replyTo, signatureImageSrc } = input;
  const visibleTo = replyBulkVisibleTo(replyTo);
  const audience = await resolveReplyBulkAudience(body);
  const { generated, normalized } = renderReplyBulk(body, visibleTo, signatureImageSrc);
  const stopped = (stoppedReason: string, status: ReplyBulkSendResult["status"] = "failed"): ReplyBulkSendResult => ({
    emailCount: 0,
    outcomes: [],
    recipientCount: audience.plan.recipients.length,
    sentEmails: 0,
    status,
    stoppedReason,
  });

  if (!normalized.subject) return stopped("Subject is required.");
  if (!normalized.replyMessage) return stopped("Reply message is required.");
  if (!visibleTo) return stopped("No Reply-To inbox is configured to show in the To line.");

  const { issues } = replyBulkIssues(body, audience.plan.recipients.length);
  if (issues.length > 0) return stopped(issues[0].message);

  const invalid = invalidCommunicationEmails(audience.plan.recipients.map((recipient) => recipient.email));
  if (invalid.length > 0) return stopped(`Invalid email address: ${invalid[0]}`);

  if (!emailNotificationsEnabled()) return stopped("EMAIL_NOTIFICATIONS_ENABLED is not true.", "skipped");

  const senderId = access.loginId ?? access.hrId ?? "unknown";
  const actor = access.loginId ?? access.hrId ?? null;
  const listJustification = `Addresses carried by the distribution list(s): ${audience.listKeys.join(", ")}.`;
  const outcomes: ReplyBulkOutcome[] = [];

  for (const [batchIndex, batch] of audience.plan.batches.entries()) {
    // Typed outside addresses were already refused without the sender's own reason above, so the
    // reason given here is the sender's when there is one, and the list's otherwise.
    const policy = validateManualEmailRecipientPolicy({
      externalJustification: normalized.externalJustification || listJustification,
      to: batch,
    });
    let outcome: ReplyBulkOutcome;
    if (policy.issues.length > 0) {
      outcome = { batchIndex, id: null, reason: policy.issues[0].message, recipients: batch.length, status: "skipped" };
    } else {
      try {
        const result = await sendPhoenixEmail({
          externalRecipients: policy.externalRecipients,
          // Hidden from each other: with more than one recipient the batch moves into Bcc behind
          // the one visible To, which is the Reply-To inbox every copy also answers to.
          fanoutToBcc: true,
          fanoutVisibleTo: visibleTo,
          from,
          html: generated.html,
          idempotencyKey: buildSatoEmailIdempotencyKey({
            attachmentIds: [],
            batch,
            batchIndex,
            clientRequestId: normalized.clientRequestId,
            html: generated.html,
            scope: "email-reply-bulk",
            senderId,
            subject: normalized.subject,
          }),
          replyTo,
          subject: normalized.subject,
          text: generated.plainText,
          to: [...batch],
        });
        outcome = result.skipped
          ? { batchIndex, id: null, reason: result.reason ?? "Not sent.", recipients: batch.length, status: "skipped" }
          : { batchIndex, id: result.id ?? null, reason: null, recipients: batch.length, status: "sent" };
      } catch (error) {
        logError("Email Reply Composer list batch failed to send", { context: { batchIndex }, error });
        outcome = { batchIndex, id: null, reason: "The email provider refused this email.", recipients: batch.length, status: "skipped" };
      }
    }
    outcomes.push(outcome);

    // One row per email, exactly as a single reply writes one — so the 30-day counts stay emails.
    await recordManualEmailSendAudit({
      actor,
      bcc: batch,
      cc: [],
      clientRequestId: `${normalized.clientRequestId}#${batchIndex + 1}`,
      externalJustification: normalized.externalJustification || listJustification,
      externalRecipients: policy.externalRecipients,
      providerMessageId: outcome.id,
      providerReason: outcome.reason,
      providerSkipped: outcome.status === "skipped",
      status: outcome.status,
      subject: normalized.subject,
      templateKey: normalized.templateKey,
      to: [visibleTo],
    }).catch((auditError) => {
      // Swallowed loudly: the email has already gone, and throwing would report it as failed.
      logError("Email Reply Composer list batch could not be recorded", { context: { batchIndex }, error: auditError });
    });
  }

  const sentEmails = outcomes.filter((outcome) => outcome.status === "sent").length;
  const status: ReplyBulkSendResult["status"] =
    sentEmails === outcomes.length ? "sent" : sentEmails === 0 ? "skipped" : "partial";

  await writeAuditLog({
    actorLoginId: actor,
    entityId: normalized.clientRequestId || null,
    entityType: "email_reply_bulk_send",
    newValues: {
      emailCount: outcomes.length,
      externalJustification: normalized.externalJustification || null,
      listKeys: audience.listKeys,
      recipientCount: audience.plan.recipients.length,
      sentEmails,
      skipped: audience.skipped.length,
      status,
      subject: normalized.subject,
      templateKey: normalized.templateKey || null,
    },
    summary: `Sent a Phoenix HR email "${normalized.subject}" to ${audience.plan.recipients.length} recipient(s) in ${outcomes.length} email(s) through distribution list(s)`,
  });

  return {
    emailCount: outcomes.length,
    outcomes,
    recipientCount: audience.plan.recipients.length,
    sentEmails,
    status,
    stoppedReason: null,
  };
}
