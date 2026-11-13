import { systemDeployment } from "@/config/system-settings";
import {
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
  type PhoenixEmailMetadataRow,
} from "@/emails/phoenix-email-layout";
import { ACTIVE_EMPLOYMENT_STATUSES } from "@/lib/auth/session-lifecycle";
import type { SendPhoenixEmailResult } from "@/lib/email/send-phoenix-email";
import { cairoDateTime12h } from "@/lib/format/cairo-datetime";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { afterResponse } from "@/lib/http/after-response";
import type { DurableEmailMessage } from "@/lib/notifications/direct-email-payload";
import { sendDurableEmail, type DurableEmailOptions } from "@/lib/notifications/durable-email";
import {
  createSystemNotificationForRecipients,
  type CreateSystemNotificationInput,
} from "@/lib/notifications/system";
import { logError, logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * WHO IS TOLD OF A NEW SAFETY REPORT (audit REC-033, owner 13 Nov 2026).
 *
 * The OWNER of every new report is whoever holds `report_it_dashboard_access` — exactly one person
 * today, the QPPV. She is read from that table at the moment of the notice, never hard-coded: no
 * person, HR id or address is named anywhere in this code. A role that reads every report through
 * `report_it:export` (Super Admin, CEO, Finance Manager) is NOT an owner and is not told.
 *
 * She gets an in-app notice and an email. 🔴 NEITHER CARRIES ANY PATIENT DATA — no patient name or
 * initials, no reaction, no medicine, no seriousness, no outcome, not even who filed it. Only that a
 * report was received, its reference, when (Cairo time), and the link to her Report It desk. An email
 * leaves the company and is mirrored to the admin's Telegram; the report itself stays behind the
 * logged read on the desk. The builder below cannot leak what it is never given: its input is the
 * reference, the time and the link, and `tests/report-it-lifecycle.test.ts` scans its output against
 * a fixture report full of distinctive patient values.
 *
 * Both run AFTER the reply (`afterResponse` — "a button's answer never waits for its notices"), and a
 * failure is logged, never thrown to the person who filed the report.
 */

export const REPORT_IT_NEW_REPORT_EVENT = "report_it_new_report";
export const REPORT_IT_NOTIFICATION_MODULE = "report_it";
/** The desk the owner follows open reports on. A portal-mode viewer is sent on to her own desk. */
export const REPORT_IT_DESK_PATH = "/admin/report-it";

/** The only facts about a report a notice may carry. Nothing about the patient is in this type. */
export type NewReportNoticeFacts = {
  reportId: string;
  reportNumber: string;
  submittedAt: string;
};

export type ReportItOwner = {
  email: string | null;
  hrId: string;
  name: string | null;
};

export type NewReportEmail = { html: string; subject: string; text: string };

export function reportItDeskUrl(): string {
  const base = (process.env.NOTIFICATION_DASHBOARD_URL || process.env.NEXT_PUBLIC_APP_URL || systemDeployment.productionUrl)
    .replace(/\/+$/, "");
  return `${base}${REPORT_IT_DESK_PATH}`;
}

export type NewReportEmailContent = {
  action: { href: string; label: string };
  body: string;
  metadataRows: PhoenixEmailMetadataRow[];
  previewText: string;
  subject: string;
  title: string;
};

/**
 * Everything the email layout is handed, in one value — so a test can scan ALL of it for patient
 * data, not only what a renderer happens to print. Its input is the reference, the time and the
 * link: nothing else exists here to leak.
 */
export function newReportEmailContent(input: { deskUrl: string; reportNumber: string; submittedAt: string }): NewReportEmailContent {
  const received = `${cairoDateTime12h(input.submittedAt)} (Cairo time)`;
  const title = "New safety report received";
  return {
    action: { href: input.deskUrl, label: "Open my Report It desk" },
    body: [
      `A new safety report, ${input.reportNumber}, was received on Report It on ${received}.`,
      `Open it on your Report It desk to assess it: ${input.deskUrl}`,
    ].join("\n\n"),
    metadataRows: [
      { label: "Reference", value: input.reportNumber },
      { label: "Received", value: received },
    ],
    previewText: `${title}: ${input.reportNumber}`,
    subject: `New safety report received: ${input.reportNumber}`,
    title,
  };
}

/** The email the owner receives, rendered in the shared Phoenix layout. */
export function buildNewReportEmail(input: { deskUrl: string; reportNumber: string; submittedAt: string }): NewReportEmail {
  const content = newReportEmailContent(input);
  const html = renderPhoenixEmailHtml({
    action: content.action,
    bodyHtml: renderEmailParagraphs(content.body),
    metadataRows: content.metadataRows,
    previewText: content.previewText,
    subject: content.subject,
    title: content.title,
  });
  const text = renderPhoenixEmailText({
    action: content.action,
    bodyText: content.body,
    metadataRows: content.metadataRows,
    title: content.title,
  });
  return { html, subject: content.subject, text };
}

/** The in-app notice — the same three facts, no patient data. */
export function buildNewReportInAppNotice(facts: NewReportNoticeFacts): Omit<CreateSystemNotificationInput, "recipientHrId" | "recipientUserId"> {
  return {
    actionUrl: REPORT_IT_DESK_PATH,
    category: "general",
    channels: ["in_app"],
    eventType: REPORT_IT_NEW_REPORT_EVENT,
    message: `Safety report ${facts.reportNumber} was received on ${cairoDateTime12h(facts.submittedAt)} (Cairo time). Open your Report It desk to assess it.`,
    metadata: { idempotencyKey: `report_it:new_report:${facts.reportId}`, reportNumber: facts.reportNumber },
    module: REPORT_IT_NOTIFICATION_MODULE,
    recordId: facts.reportId,
    title: `New safety report ${facts.reportNumber}`,
  };
}

/** The durable email's own key: one email per report per owner, however often the notice is retried. */
export function newReportEmailKey(reportId: string, ownerHrId: string): string {
  return `report_it:new_report:${reportId}:${canonicalHrIdKey(ownerHrId) ?? ownerHrId}`;
}

// ── The database half, injectable so the tests never touch one ─────────────────────────────────

export type ReportItNoticeDeps = {
  notifyInApp: (
    input: Omit<CreateSystemNotificationInput, "recipientHrId" | "recipientUserId">,
    recipientHrIds: string[],
  ) => Promise<unknown>;
  readOwners: () => Promise<ReportItOwner[]>;
  sendEmail: (message: DurableEmailMessage, options: DurableEmailOptions) => Promise<SendPhoenixEmailResult>;
};

type ReadResult = { data: unknown; error: { message: string } | null };

/**
 * The slice of a Supabase client the owner read needs — structural, so a test can drive the real
 * function with a fake (the suite runs with production credentials and must never reach a table).
 */
export type ReportItOwnerReadClient = {
  from(table: string): {
    select(columns: string): PromiseLike<ReadResult> & {
      in(column: string, values: string[]): PromiseLike<ReadResult>;
    };
  };
};

/**
 * The owners: every person on `report_it_dashboard_access` who is a current employee, with the
 * work email on their employee record. The list is read fresh each time — a grant or a removal on
 * the desk's access panel decides who is told of the very next report.
 */
export async function readReportItOwners(client?: ReportItOwnerReadClient): Promise<ReportItOwner[]> {
  const supabase = client ?? (getSupabaseAdmin() as unknown as ReportItOwnerReadClient);
  const { data: grants, error: grantError } = await supabase.from("report_it_dashboard_access").select("hr_id");
  if (grantError) throw new Error(`Failed to read the report owners: ${grantError.message}`);
  const ownerKeys = new Set(
    ((grants ?? []) as Array<{ hr_id: string | null }>).map((row) => canonicalHrIdKey(row.hr_id)).filter((key): key is string => Boolean(key)),
  );
  if (ownerKeys.size === 0) return [];

  const lookup = Array.from(new Set(Array.from(ownerKeys).flatMap((key) => hrIdLookupKeys(key))));
  const { data: employees, error: employeeError } = await supabase
    .from("employees")
    .select("hr_id,full_name,work_email,employment_status")
    .in("hr_id", lookup);
  if (employeeError) throw new Error(`Failed to read the report owners' records: ${employeeError.message}`);

  const owners = new Map<string, ReportItOwner>();
  for (const row of (employees ?? []) as Array<{
    employment_status: string | null;
    full_name: string | null;
    hr_id: string | null;
    work_email: string | null;
  }>) {
    const key = canonicalHrIdKey(row.hr_id);
    if (!key || !ownerKeys.has(key) || owners.has(key) || !row.hr_id) continue;
    if (!ACTIVE_EMPLOYMENT_STATUSES.has(String(row.employment_status ?? "").trim().toLowerCase())) continue;
    owners.set(key, { email: row.work_email?.trim() || null, hrId: row.hr_id, name: row.full_name });
  }
  return Array.from(owners.values());
}

const defaultDeps: ReportItNoticeDeps = {
  notifyInApp: (input, recipientHrIds) => createSystemNotificationForRecipients(input, recipientHrIds),
  readOwners: () => readReportItOwners(),
  sendEmail: (message, options) => sendDurableEmail(message, options),
};

/**
 * Tells every owner of a new report: one in-app notice each, and one email each through the durable
 * outbox (so a provider failure is retried, and a retried request never sends twice). Every failure
 * is logged and swallowed — the report is already filed, and the person who filed it is not told
 * anything went wrong with a notice they never asked for.
 */
export async function deliverNewReportNotices(facts: NewReportNoticeFacts, deps: ReportItNoticeDeps = defaultDeps): Promise<void> {
  let owners: ReportItOwner[];
  try {
    owners = await deps.readOwners();
  } catch (error) {
    logError("Report It: the report owners could not be read, so nobody was told of the new report", {
      error,
      labels: { event: "report_it_owner_read_failed", report_number: facts.reportNumber },
    });
    return;
  }
  if (owners.length === 0) {
    logWarning("Report It: nobody holds dashboard access, so nobody owns the new report", {
      labels: { event: "report_it_no_owner", report_number: facts.reportNumber },
    });
    return;
  }

  try {
    await deps.notifyInApp(buildNewReportInAppNotice(facts), owners.map((owner) => owner.hrId));
  } catch (error) {
    logError("Report It: the in-app notice of a new report failed", {
      error,
      labels: { event: "report_it_new_report_in_app_failed", report_number: facts.reportNumber },
    });
  }

  const email = buildNewReportEmail({ deskUrl: reportItDeskUrl(), reportNumber: facts.reportNumber, submittedAt: facts.submittedAt });
  for (const owner of owners) {
    if (!owner.email) {
      logWarning("Report It: a report owner has no work email, so only the in-app notice reached her", {
        labels: { event: "report_it_owner_without_email", report_number: facts.reportNumber },
      });
      continue;
    }
    const key = newReportEmailKey(facts.reportId, owner.hrId);
    try {
      await deps.sendEmail(
        {
          input: {
            html: email.html,
            idempotencyKey: key,
            origin: { eventType: REPORT_IT_NEW_REPORT_EVENT, module: REPORT_IT_NOTIFICATION_MODULE, recipientHrId: owner.hrId },
            subject: email.subject,
            text: email.text,
            to: [owner.email],
          },
          sender: "phoenix",
        },
        { dedupeKey: key },
      );
    } catch (error) {
      logError("Report It: the email of a new report failed", {
        error,
        labels: { event: "report_it_new_report_email_failed", report_number: facts.reportNumber },
      });
    }
  }
}

/** Called by the submit route: the notices run after the reply has gone, never before it. */
export function notifyOwnersOfNewReport(facts: NewReportNoticeFacts, deps: ReportItNoticeDeps = defaultDeps): Promise<void> {
  return afterResponse("report_it_notice:new_report", () => deliverNewReportNotices(facts, deps));
}
