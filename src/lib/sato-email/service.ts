import { systemEmail } from "@/config/system-settings";
import { writeAuditLog, writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { invalidCommunicationEmails } from "@/lib/communication/metrics";
import { getDistributionListSpecs, resolveDistributionListByKey } from "@/lib/distribution-lists/service";
import { validateManualEmailRecipientPolicy } from "@/lib/email/email-safety";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { loadSatoEmailAttachments, resolveSatoEmailAttachments, type SatoEmailAttachmentSummary } from "@/lib/sato-email/media";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";
import { emailNotificationsEnabled } from "@/lib/notifications/email";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  SATO_EMAIL_MAX_PER_EMAIL,
  buildSatoEmailIdempotencyKey,
  buildSatoEmailSendPlan,
  findUnfilledPlaceholders,
  type SatoEmailRecipient,
} from "./plan";
import { computeListCoverage } from "./list-groups";
import { satoTypedAddressPolicy } from "./typed-policy";
import { renderSatoEmail, satoEmailHtmlToText } from "./render";

/**
 * The Sato Email Composer's server half: its templates, who a send reaches, and the send itself.
 *
 * Owner 2026-09-11, in his own words: a composer where "any composers that have fixed email
 * templates … I'm able to also flip that so I can use a fixed email template or I can free type the
 * email I want", addressed to the distribution lists, "accessible for HR business partner and the
 * system administrator", wearing "the Sato identity, not the Phoenix".
 *
 * 🔴 THIS IS MANUAL MAIL, AND THAT IS THE WHOLE REASON IT LOOKS DIFFERENT FROM THE AUTOMATED PATH.
 * The owner was asked whether a large send should be held for review and answered: "i meant in
 * automated emails must be a guard but in composer its manual email by human". So no `origin` is
 * passed to sendPhoenixEmail — the Notification Confidence Gate's fan-out check is for mail nobody
 * typed. Every other guard still applies and none of them is waived: the Recipient Assurance Guard
 * still runs, suppressions still hold, `bypassConfidenceGate` is never set, and each email still
 * passes the manual recipient policy. `tests/sato-email-lists-only-composer.test.ts` pins both
 * halves of that, because "manual, so relax the guards" is exactly the reading to prevent.
 */

export type SatoEmailTemplate = {
  bodyHtml: string;
  isActive: boolean;
  name: string;
  sortOrder: number;
  subject: string;
  templateKey: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type SatoEmailListOption = {
  /** Offered lists whose rule already reaches everyone this one does — see ./list-groups. */
  coveredBy: string[];
  description: string;
  label: string;
  listKey: string;
};

export type SatoEmailEmployeeOption = {
  displayName: string;
  email: string;
  hrId: string;
  jobTitle: string | null;
  where: string | null;
};

export type SatoEmailComposerOptions = {
  lists: SatoEmailListOption[];
  templates: SatoEmailTemplate[];
  employees: SatoEmailEmployeeOption[];
  warnings: string[];
};

export type SatoEmailAudience = {
  recipients: SatoEmailRecipient[];
  /** Named on a chosen list but unreachable — no work email, or excluded on the list itself. */
  skipped: Array<{ displayName: string; hrId: string; reason: string }>;
  warnings: string[];
};

export type SatoEmailDraft = {
  /** Ids of uploaded files this email carries. Body pictures are NOT here - they are in bodyHtml. */
  attachmentIds: string[];
  bodyHtml: string;
  clientRequestId: string;
  /** Addresses the sender typed by hand, already validated and lower-cased by parseSatoEmailDraft. */
  emails: string[];
  externalJustification?: string | null;
  hrIds: string[];
  listKeys: string[];
  signOff: string;
  subject: string;
  templateKey?: string | null;
};

export type SatoEmailPreview = {
  attachments: SatoEmailAttachmentSummary[];
  /**
   * The one reason these attachments cannot be sent, resolved at PREVIEW time on purpose.
   *
   * The sender learns the files are over budget while he is still looking at the draft, not after
   * he has read a recipient count and pressed a confirm button. Send checks it again - the preview
   * is a courtesy and the server is the boundary.
   */
  attachmentProblem: string | null;
  audience: SatoEmailAudience;
  emailCount: number;
  html: string;
  /** Typed addresses outside the company domains, so the screen can say which ones need a reason. */
  outsideAddresses: string[];
  placeholders: string[];
  recipientCount: number;
  /** Why the typed addresses cannot go yet — blocks Send exactly as attachmentProblem does. */
  recipientProblem: string | null;
  text: string;
};

export type SatoEmailSendOutcome = {
  batchIndex: number;
  id: string | null;
  reason: string | null;
  recipients: number;
  status: "sent" | "skipped";
};

export type SatoEmailSendResult = {
  emailCount: number;
  outcomes: SatoEmailSendOutcome[];
  recipientCount: number;
  skippedReason: string | null;
  status: "sent" | "partial" | "skipped" | "failed";
};

const TEMPLATES_TABLE = "sato_email_templates";
const SENDS_TABLE = "sato_email_sends";

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
  "The Sato email templates table is not in this database yet — the migration has not been applied here.";

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

export async function listSatoEmailTemplates(
  options: { includeInactive?: boolean } = {},
): Promise<{ templates: SatoEmailTemplate[]; warnings: string[] }> {
  try {
    const supabase = getSupabaseAdmin();
    let query = supabase
      .from(TEMPLATES_TABLE)
      .select("template_key,name,subject,body_html,is_active,sort_order,updated_at,updated_by")
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

export async function upsertSatoEmailTemplate(
  input: { bodyHtml: string; isActive?: boolean; name: string; sortOrder?: number; subject: string; templateKey: string },
  access: AccessContext,
): Promise<SatoEmailTemplate> {
  const supabase = getSupabaseAdmin();
  const templateKey = input.templateKey.trim().toLowerCase();

  const { data: existing } = await supabase
    .from(TEMPLATES_TABLE)
    .select("template_key,name,subject,body_html,is_active,sort_order,updated_at,updated_by")
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
    .select("template_key,name,subject,body_html,is_active,sort_order,updated_at,updated_by")
    .single();
  if (error) throw error;

  // REQUIRED audit, not best-effort: a template decides the wording of a company-wide email, and
  // this write happens BEFORE any mail leaves — so refusing the edit when the trail cannot be
  // written costs nothing and loses nothing.
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId ?? null,
    entityId: templateKey,
    entityType: "sato_email_template",
    newValues: { bodyHtml: row.body_html, isActive: row.is_active, name: row.name, subject: row.subject },
    oldValues: existing
      ? {
          bodyHtml: (existing as TemplateRow).body_html,
          isActive: (existing as TemplateRow).is_active,
          name: (existing as TemplateRow).name,
          subject: (existing as TemplateRow).subject,
        }
      : null,
    summary: `${existing ? "Updated" : "Created"} Sato email template "${row.name}"`,
  });

  return toTemplate(data as TemplateRow);
}

/**
 * The lists a send may address.
 *
 * 🔴 A WHOLE-COMPANY LIST IS NEVER OFFERED HERE. `allEmployees` is the one flag that makes a list
 * resolve to every employee, and the owner's answer scoped this screen to the named lists. It is
 * withheld at the source rather than hidden in the UI, so a hand-made request naming such a list
 * gets nothing either — resolveSatoEmailAudience refuses the same set.
 */
function isAddressableList(spec: { allEmployees: boolean; enabled: boolean }): boolean {
  return spec.enabled && !spec.allEmployees;
}

export async function getSatoEmailComposerOptions(): Promise<SatoEmailComposerOptions> {
  const warnings: string[] = [];

  const [specsResult, templatesResult, directoryResult] = await Promise.allSettled([
    getDistributionListSpecs(),
    listSatoEmailTemplates(),
    getEmployeeDirectory(),
  ]);

  const lists: SatoEmailListOption[] = [];
  if (specsResult.status === "fulfilled") {
    const addressable = specsResult.value.filter(isAddressableList);
    // Coverage is computed over the OFFERED lists only, so a hint can never point at a list the
    // sender cannot see or pick.
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
  if (templatesResult.status === "fulfilled") {
    templates = templatesResult.value.templates;
    warnings.push(...templatesResult.value.warnings);
  } else {
    warnings.push("The email templates could not be loaded.");
  }

  const employees: SatoEmailEmployeeOption[] = [];
  if (directoryResult.status === "fulfilled") {
    for (const employee of directoryResult.value.employees) {
      // No employment-status filter here on purpose: getEmployeeDirectory() has already dropped
      // leavers and system consoles, exactly as loadDistributionCandidates() relies on. A second
      // filter on the raw status string would be a different rule wearing the same name, and the
      // two would drift.
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

  return { employees, lists, templates, warnings };
}

/**
 * Who this draft reaches, exactly — lists plus people picked by name, deduped by address.
 *
 * Everything that falls out is REPORTED rather than dropped: a refused list, a colleague with no
 * work email, a list nobody enabled. A recipient who quietly disappears from an audience is the
 * failure nobody sees, and the confirm step shows the sender this count before anything is sent.
 */
export async function resolveSatoEmailAudience(input: {
  emails: readonly string[];
  hrIds: readonly string[];
  listKeys: readonly string[];
}): Promise<SatoEmailAudience> {
  const warnings: string[] = [];
  const skipped: SatoEmailAudience["skipped"] = [];
  const recipients: SatoEmailRecipient[] = [];

  const specs = await getDistributionListSpecs().catch((error) => {
    logError("Sato email could not read the distribution lists", { error });
    warnings.push("The distribution lists could not be read, so no list was applied.");
    return [];
  });
  const addressable = new Map(specs.filter(isAddressableList).map((spec) => [spec.listKey, spec]));

  for (const listKey of new Set(input.listKeys)) {
    const spec = addressable.get(listKey);
    if (!spec) {
      warnings.push(`"${listKey}" is not a list this composer may address, so it was left out.`);
      continue;
    }
    const resolved = await resolveDistributionListByKey(listKey);
    warnings.push(...resolved.warnings);
    if (resolved.refusedReason) {
      warnings.push(`${resolved.label}: ${resolved.refusedReason}`);
      continue;
    }
    for (const member of resolved.members) {
      recipients.push({ email: member.email, hrId: member.hrId, name: member.displayName });
    }
    for (const external of resolved.externalEmails) {
      recipients.push({ email: external, hrId: null, name: external });
    }
    for (const entry of resolved.skipped) {
      skipped.push({
        displayName: entry.displayName,
        hrId: entry.hrId,
        reason: entry.reason === "no_work_email" ? `${resolved.label}: no work email on record` : `${resolved.label}: excluded from the list`,
      });
    }
  }

  const wantedHrIds = new Set(
    [...input.hrIds].map((value) => canonicalHrIdKey(value) ?? "").filter(Boolean),
  );
  if (wantedHrIds.size > 0) {
    const directory = await getEmployeeDirectory();
    const byKey = new Map(
      directory.employees.map((employee) => [canonicalHrIdKey(employee.hrId) ?? employee.hrId, employee]),
    );
    for (const key of wantedHrIds) {
      const employee = byKey.get(key);
      if (!employee) {
        warnings.push(`One selected colleague is no longer in the directory and was left out.`);
        continue;
      }
      const email = String(employee.workEmail ?? "").trim();
      const displayName = employee.displayName || employee.fullName;
      if (!email) {
        skipped.push({ displayName, hrId: employee.hrId, reason: "Picked by name: no work email on record" });
        continue;
      }
      recipients.push({ email, hrId: employee.hrId, name: displayName });
    }
  }

  // Typed by hand. Each is its own recipient, deduped against the lists and the named colleagues by
  // the send plan — so an address that is also on a picked list is counted, and mailed, once.
  for (const email of new Set(input.emails.map((value) => value.trim().toLowerCase()).filter(Boolean))) {
    recipients.push({ email, hrId: null, name: email });
  }

  return { recipients, skipped, warnings };
}

function normalizeDraft(draft: SatoEmailDraft) {
  return {
    attachmentIds: Array.isArray(draft.attachmentIds) ? draft.attachmentIds : [],
    bodyHtml: String(draft.bodyHtml ?? "").trim(),
    clientRequestId: String(draft.clientRequestId ?? "").trim(),
    emails: Array.isArray(draft.emails) ? draft.emails : [],
    externalJustification: draft.externalJustification ?? null,
    hrIds: Array.isArray(draft.hrIds) ? draft.hrIds : [],
    listKeys: Array.isArray(draft.listKeys) ? draft.listKeys : [],
    signOff: String(draft.signOff ?? "").trim(),
    subject: String(draft.subject ?? "").trim(),
    templateKey: draft.templateKey ? String(draft.templateKey).trim() : null,
  };
}

export async function previewSatoEmail(draft: SatoEmailDraft): Promise<SatoEmailPreview> {
  const normalized = normalizeDraft(draft);
  const audience = await resolveSatoEmailAudience({
    emails: normalized.emails,
    hrIds: normalized.hrIds,
    listKeys: normalized.listKeys,
  });
  const plan = buildSatoEmailSendPlan(audience.recipients);
  const { html, text } = renderSatoEmail({
    bodyHtml: normalized.bodyHtml,
    signOff: normalized.signOff,
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
 * The From address, wearing the company's name.
 *
 * The address is `systemEmail.satoComposerFromEmail` — the HR Business Partner's mailbox, owner
 * 2026-09-12 — and the display name is "Sato Pharma": the owner asked for the company's identity,
 * and what a recipient reads in their inbox list is the display name.
 */
export function satoEmailFrom(configured: string): string {
  const match = configured.match(/<([^>]+)>/);
  const address = (match ? match[1] : configured).trim();
  return `Sato Pharma <${address}>`;
}

export async function sendSatoEmail(draft: SatoEmailDraft, access: AccessContext): Promise<SatoEmailSendResult> {
  const normalized = normalizeDraft(draft);
  const audience = await resolveSatoEmailAudience({
    emails: normalized.emails,
    hrIds: normalized.hrIds,
    listKeys: normalized.listKeys,
  });
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
  // is refused without one — see ./typed-policy for why a partial send is the wrong answer here.
  const typed = satoTypedAddressPolicy(normalized.emails, normalized.externalJustification);
  if (typed.problem) {
    return { ...empty, skippedReason: typed.problem, status: "failed" };
  }

  if (!emailNotificationsEnabled()) {
    return { ...empty, skippedReason: "EMAIL_NOTIFICATIONS_ENABLED is not true." };
  }

  const { html, text } = renderSatoEmail({
    bodyHtml: normalized.bodyHtml,
    signOff: normalized.signOff,
    subject: normalized.subject,
  });
  // 🔴 READ ONCE, BEFORE ANY MAIL LEAVES, AND REFUSE THE WHOLE SEND IF THEY CANNOT GO.
  // `guardAttachments` in send-phoenix-email.ts silently drops an over-budget file and sends the
  // mail anyway. That is a defensible default for a system notification and completely wrong here:
  // "the new policy is attached" reaching a whole distribution list with nothing attached cannot be
  // recalled, and nothing on the sender's screen would have said so. Reading them before the loop
  // also means a storage failure stops the send at batch zero rather than half way down the list.
  const loaded = await loadSatoEmailAttachments(normalized.attachmentIds);
  if ("problem" in loaded) {
    return { ...empty, skippedReason: loaded.problem, status: "failed" };
  }
  const attachments = loaded.attachments.length > 0 ? loaded.attachments : undefined;

  // Every composer mail goes out as the HR Business Partner's mailbox, whoever presses Send.
  const from = satoEmailFrom(systemEmail.satoComposerFromEmail);
  // 🔴 Replies reach the OWNER's mailbox, for every sender — owner 2026-09-17, "i want reply to
  // reach omar.anwar@satopharma.com". ONE address for everyone on purpose: keyed on the seat, a
  // Super Admin send fell through to phoenix@satopharma.com — an inbox Resend suppresses for hard
  // bounces — so every composer mail showed a suppressed To and its replies bounced (owner's test
  // send, 2026-09-13). Never key this on the sender, and never point it at an untested inbox.
  const replyTo = systemEmail.satoComposerReplyToEmail;
  // What a recipient READS in the To line of a fan-out is the apex HR Business Partner mailbox — a
  // REAL inbox, deliberately NOT the same address the mail is From (see satoComposerFanoutVisibleTo):
  // this is a genuine envelope recipient Resend actually delivers to, and the From subdomain has no
  // live mailbox behind it. Without this, the fan-out would put the owner's own Reply-To address in
  // the visible To of every multi-recipient send.
  const fanoutVisibleTo = systemEmail.satoComposerFanoutVisibleTo;
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
        // Every batch carries the same files: the batching is a recipient-count cap, not a difference
        // between the emails. A recipient in batch three must get the same attachment as batch one.
        attachments,
        // Hidden from each other: the owner chose "keep them hidden". With more than one recipient
        // the fan-out moves the batch into Bcc behind a neutral visible To.
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
          senderId,
          subject: normalized.subject,
        }),
        replyTo,
        subject: normalized.subject,
        text,
        to: [...batch],
      });
    } catch (error) {
      logError("Sato email batch failed to send", { context: { batchIndex }, error });
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

  await recordSatoEmailSend({ access, audience, draft: normalized, plan, result });
  return result;
}

/**
 * Why an address outside satopharma.com is on this email.
 *
 * A distribution list may legitimately carry an outside address (a contractor, a shared clinic
 * inbox), and the manual policy asks for a justification whenever one is present. Naming the lists
 * is a truthful one — it says exactly where the address came from — and it means the sender is not
 * asked to re-justify a decision somebody already recorded on the list itself.
 */
function listJustification(listKeys: readonly string[]): string {
  if (listKeys.length === 0) return "Recipients picked by name from the employee directory.";
  return `Addresses carried by the distribution list(s): ${listKeys.join(", ")}.`;
}

async function recordSatoEmailSend(input: {
  access: AccessContext;
  audience: SatoEmailAudience;
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
      email_count: result.emailCount,
      // AccessContext.hrId and the picker both hand back the lowercase COMPARISON key. Writing
      // either raw is what left ~37,000 lowercase actor ids across the database — silent, because
      // the app canonicalises its own lookups and only a naive .eq feels it, returning nothing at
      // all rather than something wrong. Both go through hrIdForStorage.
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
    logError("Sato email send could not be recorded", {
      labels: { event: "sato_email_send_log_failed" },
      context: { recipientCount: result.recipientCount, status: result.status },
      error,
    });
  }

  await writeAuditLog({
    actorLoginId: access.loginId ?? access.hrId ?? null,
    entityId: draft.clientRequestId,
    entityType: "sato_email_send",
    newValues: {
      emailCount: result.emailCount,
      externalJustification: draft.externalJustification,
      listKeys: draft.listKeys,
      recipientCount: result.recipientCount,
      status: result.status,
      subject: draft.subject,
      templateKey: draft.templateKey,
      typedEmails: draft.emails,
    },
    summary: `Sent a Sato email "${draft.subject}" to ${result.recipientCount} recipient(s) in ${result.emailCount} email(s)`,
  });
}

export { SATO_EMAIL_MAX_PER_EMAIL };
