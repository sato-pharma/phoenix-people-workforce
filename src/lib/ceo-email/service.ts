import { systemEmail } from "@/config/system-settings";
import { writeAuditLog, writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { invalidCommunicationEmails } from "@/lib/communication/metrics";
import { getDistributionListSpecs } from "@/lib/distribution-lists/service";
import { validateManualEmailRecipientPolicy } from "@/lib/email/email-safety";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { hrIdForStorage } from "@/lib/hr-id";
import { emailNotificationsEnabled } from "@/lib/notifications/email";
import { logError } from "@/lib/observability/log";
import { computeListCoverage } from "@/lib/sato-email/list-groups";
import { loadSatoEmailAttachments, resolveSatoEmailAttachments } from "@/lib/sato-email/media";
import {
  buildSatoEmailIdempotencyKey,
  buildSatoEmailSendPlan,
  findUnfilledPlaceholders,
  SATO_EMAIL_MAX_PER_EMAIL,
} from "@/lib/sato-email/plan";
import {
  resolveSatoEmailAudience,
  type SatoEmailDraft,
  type SatoEmailEmployeeOption,
  type SatoEmailListOption,
  type SatoEmailPreview,
  type SatoEmailSendOutcome,
  type SatoEmailSendResult,
  type SatoEmailTemplate,
} from "@/lib/sato-email/service";
import { satoTypedAddressPolicy } from "@/lib/sato-email/typed-policy";
import { satoEmailHtmlToText } from "@/lib/sato-email/render";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { normalizeCeoClosing, resolveCeoSignature } from "./identity";
import { renderCeoEmail } from "./render";

/**
 * The CEO Email Composer's server half: its own templates, its own send log, and a letter that goes
 * out over the chief executive's name.
 *
 * Owner 2026-10-06: *"a module thats called ceo email composr exactly as sato email composer copy
 * paste but a more corporate templete … and the templete is wiith the signature of the ceo"*.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 "EXACTLY AS THE SATO COMPOSER" IS IMPLEMENTED BY CALLING THE SATO COMPOSER'S OWN FUNCTIONS,
 * NOT BY COPYING THEM.
 *
 * Everything that decides WHO a send reaches, how it is cut into messages, how a typed outside
 * address is justified, how attachments are budgeted and how a double-click is deduplicated is the
 * same code this screen's older sibling runs — `resolveSatoEmailAudience`, `buildSatoEmailSendPlan`,
 * `satoTypedAddressPolicy`, `loadSatoEmailAttachments`, `buildSatoEmailIdempotencyKey`. Each of
 * those carries a rule that cost a real incident to learn (a whole-company list is never offered; a
 * recipient who falls out is reported and never dropped; an over-budget attachment REFUSES the send
 * rather than going without the file). A second copy of any of them is a second place for one of
 * those rules to rot, and nothing would report the drift.
 *
 * What is this module's own is the part the owner actually asked to be different: the LETTERHEAD
 * (./render), the SIGNATURE and where it may come from (./identity), the ASSISTANT (./assist), the
 * two tables below, and the three addresses this mail travels under.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */

export type CeoEmailComposerOptions = {
  /** Whether speech can be turned into words on this server, so the mic is never offered inertly. */
  dictationAvailable: boolean;
  employees: SatoEmailEmployeeOption[];
  lists: SatoEmailListOption[];
  /** Who the letterhead will sign, read from the directory — shown on screen before he writes. */
  signature: Awaited<ReturnType<typeof resolveCeoSignature>>;
  templates: SatoEmailTemplate[];
  warnings: string[];
};

const TEMPLATES_TABLE = "ceo_email_templates";
const SENDS_TABLE = "ceo_email_sends";

/** The provider-side label on this screen's idempotency keys. See `buildSatoEmailIdempotencyKey`. */
const IDEMPOTENCY_SCOPE = "ceo-email";

/**
 * A missing table answers PostgREST's `PGRST205`, not Postgres's `42P01` — the deploy-before-
 * migration window would 500 the whole page on the obvious guard alone. Both spellings, one case.
 */
function isMissingTable(error: unknown): boolean {
  const code = String((error as { code?: string } | null)?.code ?? "");
  const message = String((error as { message?: string } | null)?.message ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || (message.includes("relation") && message.includes("does not exist"));
}

const MISSING_TABLES_WARNING =
  "The CEO email templates table is not in this database yet — the migration has not been applied here.";

type TemplateRow = {
  body_html: string | null;
  is_active: boolean | null;
  name: string | null;
  sort_order: number | null;
  subject: string | null;
  template_key: string;
  updated_at: string | null;
  updated_by: string | null;
};

function toTemplate(row: TemplateRow): SatoEmailTemplate {
  return {
    bodyHtml: row.body_html ?? "",
    isActive: row.is_active !== false,
    name: row.name ?? row.template_key,
    sortOrder: Number(row.sort_order ?? 100),
    subject: row.subject ?? "",
    templateKey: row.template_key,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

const TEMPLATE_COLUMNS = "template_key,name,subject,body_html,is_active,sort_order,updated_at,updated_by";

export async function listCeoEmailTemplates(
  options: { includeInactive?: boolean } = {},
): Promise<{ templates: SatoEmailTemplate[]; warnings: string[] }> {
  try {
    const supabase = getSupabaseAdmin();
    let query = supabase
      .from(TEMPLATES_TABLE)
      .select(TEMPLATE_COLUMNS)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    if (!options.includeInactive) query = query.eq("is_active", true);
    const { data, error } = await query;
    if (error) throw error;
    return { templates: ((data ?? []) as TemplateRow[]).map(toTemplate), warnings: [] };
  } catch (error) {
    if (isMissingTable(error)) return { templates: [], warnings: [MISSING_TABLES_WARNING] };
    throw error;
  }
}

export async function upsertCeoEmailTemplate(
  input: { bodyHtml: string; isActive?: boolean; name: string; sortOrder?: number; subject: string; templateKey: string },
  access: AccessContext,
): Promise<SatoEmailTemplate> {
  const supabase = getSupabaseAdmin();
  const templateKey = input.templateKey.trim().toLowerCase();

  const { data: existing } = await supabase
    .from(TEMPLATES_TABLE)
    .select(TEMPLATE_COLUMNS)
    .eq("template_key", templateKey)
    .maybeSingle();

  const row = {
    body_html: input.bodyHtml,
    is_active: input.isActive ?? true,
    name: input.name.trim(),
    sort_order: input.sortOrder ?? Number((existing as TemplateRow | null)?.sort_order ?? 100),
    subject: input.subject,
    template_key: templateKey,
    updated_at: new Date().toISOString(),
    updated_by: access.loginId ?? access.hrId ?? null,
  };

  const { data, error } = await supabase
    .from(TEMPLATES_TABLE)
    .upsert(row, { onConflict: "template_key" })
    .select(TEMPLATE_COLUMNS)
    .single();
  if (error) throw error;

  // REQUIRED audit, not best-effort: a template decides the wording of a letter the whole company
  // reads over the chief executive's signature, and this write happens BEFORE any mail leaves — so
  // refusing the edit when the trail cannot be written costs nothing and loses nothing.
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId ?? null,
    entityId: templateKey,
    entityType: "ceo_email_template",
    newValues: { bodyHtml: row.body_html, isActive: row.is_active, name: row.name, subject: row.subject },
    oldValues: existing
      ? {
          bodyHtml: (existing as TemplateRow).body_html,
          isActive: (existing as TemplateRow).is_active,
          name: (existing as TemplateRow).name,
          subject: (existing as TemplateRow).subject,
        }
      : null,
    summary: `${existing ? "Updated" : "Created"} CEO email template "${row.name}"`,
  });

  return toTemplate(data as TemplateRow);
}

/**
 * 🔴 A WHOLE-COMPANY LIST IS NEVER OFFERED HERE EITHER, and the reason is the Sato composer's own:
 * `allEmployees` is the one flag that makes a list resolve to every employee, the owner scoped the
 * composers to the named lists, and it is withheld at the SOURCE rather than hidden in the UI so a
 * hand-made request naming such a list gets nothing. `resolveSatoEmailAudience` refuses the same
 * set, which is exactly why this screen calls that function instead of writing its own.
 */
function isAddressableList(spec: { allEmployees: boolean; enabled: boolean }): boolean {
  return spec.enabled && !spec.allEmployees;
}

export async function getCeoEmailComposerOptions(): Promise<CeoEmailComposerOptions> {
  const warnings: string[] = [];

  const [specsResult, templatesResult, directoryResult, signature] = await Promise.all([
    getDistributionListSpecs().then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: [] }),
    ),
    listCeoEmailTemplates().then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: { templates: [] as SatoEmailTemplate[], warnings: [] as string[] } }),
    ),
    getEmployeeDirectory().then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: null }),
    ),
    resolveCeoSignature(),
  ]);

  const lists: SatoEmailListOption[] = [];
  if (specsResult.ok) {
    const addressable = specsResult.value.filter(isAddressableList);
    // Coverage is computed over the OFFERED lists only, so a hint can never point at a list he
    // cannot see or pick.
    const coverage = computeListCoverage(addressable);
    for (const spec of addressable) {
      lists.push({
        coveredBy: coverage.get(spec.listKey) ?? [],
        description: spec.description,
        label: spec.label,
        listKey: spec.listKey,
      });
    }
  } else {
    warnings.push("The distribution lists could not be loaded.");
  }

  let templates: SatoEmailTemplate[] = [];
  if (templatesResult.ok) {
    templates = templatesResult.value.templates;
    warnings.push(...templatesResult.value.warnings);
  } else {
    warnings.push("The letter templates could not be loaded.");
  }

  const employees: SatoEmailEmployeeOption[] = [];
  if (directoryResult.ok && directoryResult.value) {
    for (const employee of directoryResult.value.employees) {
      // No employment-status filter here on purpose: getEmployeeDirectory() has already dropped
      // leavers and system consoles, exactly as the distribution-list resolver relies on. A second
      // filter on the raw status string would be a different rule wearing the same name.
      const email = String(employee.workEmail ?? "").trim();
      if (!email) continue;
      employees.push({
        displayName: employee.displayName || employee.fullName,
        email: email.toLowerCase(),
        hrId: employee.hrId,
        jobTitle: employee.positionTitle || employee.jobTitle || null,
        where: employee.areaName || employee.lineName || employee.departmentName || null,
      });
    }
    employees.sort((a, b) => a.displayName.localeCompare(b.displayName));
  } else {
    warnings.push("The employee directory could not be loaded, so people cannot be picked by name.");
  }

  if (!signature.fromDirectory) {
    // Said out loud rather than swallowed: the letter is about to be signed from a constant, and the
    // one person who can tell whether that name is still right is reading this screen.
    warnings.push(
      "The chief executive's name could not be read from the employee directory, so the letterhead will sign from the recorded name. Check it before sending.",
    );
  }

  return {
    dictationAvailable: Boolean(process.env.GROQ_API_KEY?.trim()),
    employees,
    lists,
    signature,
    templates,
    warnings,
  };
}

/** The draft shape is the Sato composer's, with `signOff` carrying the CLOSING LINE — see ./identity. */
export type CeoEmailDraft = SatoEmailDraft;

function normalizeDraft(draft: CeoEmailDraft) {
  return {
    attachmentIds: Array.isArray(draft.attachmentIds) ? draft.attachmentIds : [],
    bodyHtml: String(draft.bodyHtml ?? "").trim(),
    clientRequestId: String(draft.clientRequestId ?? "").trim(),
    // 🔴 The closing line, NOT a name. The name on the letter comes from ./identity, server-side.
    closing: normalizeCeoClosing(String(draft.signOff ?? "")),
    emails: Array.isArray(draft.emails) ? draft.emails : [],
    externalJustification: draft.externalJustification ?? null,
    hrIds: Array.isArray(draft.hrIds) ? draft.hrIds : [],
    listKeys: Array.isArray(draft.listKeys) ? draft.listKeys : [],
    subject: String(draft.subject ?? "").trim(),
    templateKey: draft.templateKey ? String(draft.templateKey).trim() : null,
  };
}

export async function previewCeoEmail(draft: CeoEmailDraft): Promise<SatoEmailPreview> {
  const normalized = normalizeDraft(draft);
  const [audience, signature] = await Promise.all([
    resolveSatoEmailAudience({
      emails: normalized.emails,
      hrIds: normalized.hrIds,
      listKeys: normalized.listKeys,
    }),
    resolveCeoSignature(),
  ]);
  const plan = buildSatoEmailSendPlan(audience.recipients);
  const { html, text } = renderCeoEmail({
    bodyHtml: normalized.bodyHtml,
    closing: normalized.closing,
    signature,
    subject: normalized.subject,
  });
  const attachments = await resolveSatoEmailAttachments(normalized.attachmentIds);
  const typed = satoTypedAddressPolicy(normalized.emails, normalized.externalJustification);

  return {
    attachmentProblem: attachments.problem,
    attachments: attachments.files,
    audience: { ...audience, recipients: plan.recipients },
    emailCount: plan.batches.length,
    html,
    outsideAddresses: typed.outside,
    placeholders: findUnfilledPlaceholders(normalized.subject, satoEmailHtmlToText(normalized.bodyHtml)),
    recipientCount: plan.recipients.length,
    recipientProblem: typed.problem,
    text,
  };
}

/**
 * The From address, wearing the chief executive's name.
 *
 * 🔴 THE DISPLAY NAME IS THE PERSON AND HIS OFFICE; THE ADDRESS IS ON THE `send.` SUBDOMAIN AND MUST
 * STAY THERE. `system-settings.ts` records what was measured on the Sato composer: an apex
 * `@satopharma.com` From was reported "verified" by Resend and every send came back delivered, while
 * `email_delivery_events` showed a 0% open rate over 36 sends — because the recipients' own mailboxes
 * live on that apex domain (MX → Yahoo Business Mail), so mail claiming the exact same identity but
 * arriving via a different relay matches the shape of a spoofed sender and is filed as bulk. SPF,
 * DKIM and DMARC all passing does not prevent it. Replies and the visible To are apex addresses, and
 * that is fine — DMARC keys off the From header, never the To.
 */
export function ceoEmailFrom(configured: string, signerName: string): string {
  const match = configured.match(/<([^>]+)>/);
  const address = (match ? match[1] : configured).trim();
  const name = signerName.trim();
  return name ? `${name}, Chief Executive Officer <${address}>` : `Office of the Chief Executive <${address}>`;
}

export async function sendCeoEmail(draft: CeoEmailDraft, access: AccessContext): Promise<SatoEmailSendResult> {
  const normalized = normalizeDraft(draft);
  const [audience, signature] = await Promise.all([
    resolveSatoEmailAudience({
      emails: normalized.emails,
      hrIds: normalized.hrIds,
      listKeys: normalized.listKeys,
    }),
    resolveCeoSignature(),
  ]);
  const plan = buildSatoEmailSendPlan(audience.recipients);

  const empty: SatoEmailSendResult = {
    emailCount: 0,
    outcomes: [],
    recipientCount: plan.recipients.length,
    skippedReason: null,
    status: "skipped",
  };

  if (plan.recipients.length === 0) {
    return { ...empty, skippedReason: "Nobody to send to." };
  }

  const invalid = invalidCommunicationEmails(plan.recipients.map((recipient) => recipient.email));
  if (invalid.length > 0) {
    return { ...empty, skippedReason: `Invalid email address: ${invalid[0]}`, status: "failed" };
  }

  // A typed address outside the company goes only with the sender's own reason, and the whole send
  // is refused without one — see sato-email/typed-policy for why a partial send is the wrong answer.
  const typed = satoTypedAddressPolicy(normalized.emails, normalized.externalJustification);
  if (typed.problem) {
    return { ...empty, skippedReason: typed.problem, status: "failed" };
  }

  if (!emailNotificationsEnabled()) {
    return { ...empty, skippedReason: "EMAIL_NOTIFICATIONS_ENABLED is not true." };
  }

  const { html, text } = renderCeoEmail({
    bodyHtml: normalized.bodyHtml,
    closing: normalized.closing,
    signature,
    subject: normalized.subject,
  });

  // 🔴 READ ONCE, BEFORE ANY MAIL LEAVES, AND REFUSE THE WHOLE SEND IF THEY CANNOT GO.
  // `guardAttachments` in send-phoenix-email.ts silently drops an over-budget file and sends the
  // mail anyway — a defensible default for a system notification and completely wrong here: "the
  // paper is attached" over the chief executive's signature, with nothing attached, cannot be
  // recalled and nothing on his screen would have said so.
  const loaded = await loadSatoEmailAttachments(normalized.attachmentIds);
  if ("problem" in loaded) {
    return { ...empty, skippedReason: loaded.problem, status: "failed" };
  }
  const attachments = loaded.attachments.length > 0 ? loaded.attachments : undefined;

  const from = ceoEmailFrom(systemEmail.ceoComposerFromEmail, signature.name);
  const replyTo = systemEmail.ceoComposerReplyToEmail;
  const fanoutVisibleTo = systemEmail.ceoComposerFanoutVisibleTo;
  const senderId = access.loginId ?? access.hrId ?? "unknown";

  const outcomes: SatoEmailSendOutcome[] = [];
  for (const [batchIndex, batch] of plan.batches.entries()) {
    const policy = validateManualEmailRecipientPolicy({
      externalJustification: normalized.externalJustification ?? listJustification(normalized.listKeys),
      to: batch,
    });
    if (policy.issues.length > 0) {
      outcomes.push({
        batchIndex,
        id: null,
        reason: policy.issues[0].message,
        recipients: batch.length,
        status: "skipped",
      });
      continue;
    }

    let result: Awaited<ReturnType<typeof sendPhoenixEmail>>;
    try {
      result = await sendPhoenixEmail({
        // Every batch carries the same files: the batching is a recipient-count cap, not a
        // difference between the letters. A recipient in batch three gets batch one's attachment.
        attachments,
        // Hidden from each other, the owner's choice on the Sato composer and no less true of a
        // letter from the chief executive: with more than one recipient the fan-out moves the batch
        // into Bcc behind a neutral visible To.
        fanoutToBcc: true,
        fanoutVisibleTo,
        externalRecipients: policy.externalRecipients,
        from,
        html,
        idempotencyKey: buildSatoEmailIdempotencyKey({
          attachmentIds: normalized.attachmentIds,
          batch,
          batchIndex,
          clientRequestId: normalized.clientRequestId,
          html,
          scope: IDEMPOTENCY_SCOPE,
          senderId,
          subject: normalized.subject,
        }),
        replyTo,
        subject: normalized.subject,
        text,
        to: [...batch],
      });
    } catch (error) {
      logError("CEO email batch failed to send", { context: { batchIndex }, error });
      outcomes.push({
        batchIndex,
        id: null,
        reason: "The email provider refused this batch.",
        recipients: batch.length,
        status: "skipped",
      });
      continue;
    }

    if (result.skipped) {
      outcomes.push({ batchIndex, id: null, reason: result.reason, recipients: batch.length, status: "skipped" });
    } else {
      outcomes.push({ batchIndex, id: result.id ?? null, reason: null, recipients: batch.length, status: "sent" });
    }
  }

  const sent = outcomes.filter((outcome) => outcome.status === "sent").length;
  const status: SatoEmailSendResult["status"] =
    sent === outcomes.length ? "sent" : sent === 0 ? "skipped" : "partial";

  const result: SatoEmailSendResult = {
    emailCount: plan.batches.length,
    outcomes,
    recipientCount: plan.recipients.length,
    skippedReason: null,
    status,
  };

  await recordCeoEmailSend({ access, draft: normalized, plan, result });
  return result;
}

/**
 * Why an address outside satopharma.com is on this letter. A list may legitimately carry one, and
 * naming the lists is a truthful justification — it says exactly where the address came from.
 */
function listJustification(listKeys: readonly string[]): string {
  if (listKeys.length === 0) return "Recipients picked by name from the employee directory.";
  return `Addresses carried by the distribution list(s): ${listKeys.join(", ")}.`;
}

async function recordCeoEmailSend(input: {
  access: AccessContext;
  draft: ReturnType<typeof normalizeDraft>;
  plan: ReturnType<typeof buildSatoEmailSendPlan>;
  result: SatoEmailSendResult;
}) {
  const { access, draft, plan, result } = input;
  const sent = result.outcomes.filter((outcome) => outcome.status === "sent").length;

  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from(SENDS_TABLE).insert({
      client_request_id: draft.clientRequestId,
      closing_line: draft.closing,
      email_count: result.emailCount,
      // AccessContext.hrId and the picker both hand back the lowercase COMPARISON key. Writing
      // either raw is what left ~37,000 lowercase actor ids across the database — silent, because
      // the app canonicalises its own lookups and only a naive .eq feels it. Both go through
      // hrIdForStorage.
      employee_hr_ids: draft.hrIds.map((hrId) => hrIdForStorage(hrId)).filter((hrId): hrId is string => Boolean(hrId)),
      failed_emails: 0,
      list_keys: draft.listKeys,
      outcomes: result.outcomes,
      recipient_count: result.recipientCount,
      recipient_emails: plan.recipients.map((recipient) => recipient.email),
      sender_hr_id: hrIdForStorage(access.hrId),
      sender_login_id: access.loginId ?? null,
      sender_role: access.role,
      sent_emails: sent,
      skipped_emails: result.outcomes.length - sent,
      status: result.status,
      subject: draft.subject,
      template_key: draft.templateKey,
    });
    if (error) throw error;
  } catch (error) {
    // Swallowed deliberately, and loudly. The mail has already gone by the time this runs; throwing
    // here would report a completed send as a failure and invite a second one.
    logError("CEO email send could not be recorded", {
      labels: { event: "ceo_email_send_log_failed" },
      context: { recipientCount: result.recipientCount, status: result.status },
      error,
    });
  }

  await writeAuditLog({
    actorLoginId: access.loginId ?? access.hrId ?? null,
    entityId: draft.clientRequestId,
    entityType: "ceo_email_send",
    newValues: {
      closingLine: draft.closing,
      emailCount: result.emailCount,
      externalJustification: draft.externalJustification,
      listKeys: draft.listKeys,
      recipientCount: result.recipientCount,
      status: result.status,
      subject: draft.subject,
      templateKey: draft.templateKey,
      typedEmails: draft.emails,
    },
    summary: `Sent a CEO letter "${draft.subject}" to ${result.recipientCount} recipient(s) in ${result.emailCount} email(s)`,
  });
}

export { SATO_EMAIL_MAX_PER_EMAIL as CEO_EMAIL_MAX_PER_EMAIL };
