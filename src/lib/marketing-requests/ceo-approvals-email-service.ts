import { createHash } from "node:crypto";

import { systemEmail } from "@/config/system-settings";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { assertNotSeatView } from "@/lib/auth/seat-view";
import { assertNotTestAccount } from "@/lib/auth/test-persona";
import { todayInCairo } from "@/lib/date-only";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { afterResponse } from "@/lib/http/after-response";
import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { resolveCeoApprovalsRange } from "@/lib/marketing-requests/ceo-approvals";
import {
  APPROVED_REQUESTS_EMAIL_EVENT,
  APPROVED_REQUESTS_EMAIL_MODULE,
  APPROVED_REQUESTS_FINANCE_CONTACT_HR_ID,
  APPROVED_REQUESTS_FIXED_CC_HR_IDS,
  APPROVED_REQUESTS_MAX_RECIPIENTS,
  APPROVED_REQUESTS_TO_HR_IDS,
  approvedRequestsNoticeMessage,
  approvedRequestsSubject,
  canSendMarketingCeoApprovalsEmail,
  financeHoldNames,
  normalizeEmailSelection,
  renderApprovedRequestsEmail,
  resolveApprovedRequestsRecipients,
  type ApprovedRequestsEmailContent,
  type ApprovedRequestsPerson,
  type ApprovedRequestsRecipient,
} from "@/lib/marketing-requests/ceo-approvals-email";
import { getMarketingCeoApprovals } from "@/lib/marketing-requests/ceo-approvals-service";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type EmployeeRow = {
  employment_status: string | null;
  full_name: string | null;
  hr_id: string;
  job_title: string | null;
  manager_hr_id: string | null;
  work_email: string | null;
};

// Measured 2026-11-08: active, resigned, terminated, historical_payroll_record, declined_offer and
// system_placeholder. Only "active" is a person at work, so only "active" is emailed.
const ACTIVE_STATUS = "active";

/**
 * Everyone the email can reach, read in rounds: the people named up front, then their managers,
 * then theirs, up to five rounds — enough for a rep → District → Regional → National Sales Manager.
 * Mixed-case HR ids are asked in every spelling (`hrIdLookupKeys`) and folded back by
 * `canonicalHrIdKey`, so a lower-case id never reads as "not in the directory".
 */
async function loadPeople(seedHrIds: readonly string[]): Promise<Map<string, ApprovedRequestsPerson>> {
  const supabase = getSupabaseAdmin();
  const rows = new Map<string, EmployeeRow>();
  let pending = Array.from(new Set(seedHrIds.filter(Boolean)));
  for (let round = 0; round < 5 && pending.length > 0; round += 1) {
    const keys = Array.from(new Set(pending.flatMap((id) => hrIdLookupKeys(id))));
    for (let index = 0; index < keys.length; index += 50) {
      const { data, error } = await supabase
        .from("employees")
        .select("hr_id, full_name, job_title, work_email, manager_hr_id, employment_status")
        .in("hr_id", keys.slice(index, index + 50));
      if (error) throw error;
      for (const row of (data ?? []) as EmployeeRow[]) {
        const key = canonicalHrIdKey(row.hr_id);
        if (key) rows.set(key, row);
      }
    }
    pending = Array.from(rows.values())
      .map((row) => row.manager_hr_id)
      .filter((id): id is string => Boolean(id) && !rows.has(canonicalHrIdKey(id) ?? ""));
  }

  const names = await namesByHrId(Array.from(rows.values()).map((row) => row.hr_id));
  const people = new Map<string, ApprovedRequestsPerson>();
  for (const [key, row] of rows) {
    people.set(key, {
      email: row.work_email,
      hrId: row.hr_id,
      isActive: String(row.employment_status ?? "").trim().toLowerCase() === ACTIVE_STATUS,
      jobTitle: row.job_title,
      managerHrId: row.manager_hr_id,
      name: names.get(row.hr_id) || String(row.full_name ?? "").trim() || row.hr_id,
    });
  }
  return people;
}

export type ApprovedRequestsEmailPreview = {
  cc: Array<{ email: string; name: string }>;
  holdNames: string[];
  redCount: number;
  rowCount: number;
  subject: string;
  to: Array<{ email: string; name: string }>;
  totalValue: number;
  warnings: string[];
};

export type ApprovedRequestsEmailResult = ApprovedRequestsEmailPreview & {
  sent: boolean;
  sentAtIso: string | null;
  skippedReason: string | null;
};

function visible(list: readonly ApprovedRequestsRecipient[]) {
  return list.map((person) => ({ email: person.email, name: person.name }));
}

/**
 * Build — and unless `dryRun`, send — the "Approved requests" email for the ticked rows.
 *
 * The rows are re-read from the database for the posted range; the client only names WHICH rows,
 * with a note and a mark each. So nothing a browser sends can add a request outside the range or
 * change a value, a requester or a recipient.
 */
export async function sendMarketingCeoApprovalsEmail(
  access: AccessContext,
  body: { dryRun?: unknown; from?: unknown; rows?: unknown; to?: unknown },
): Promise<ApprovedRequestsEmailResult> {
  if (!canSendMarketingCeoApprovalsEmail(access.role)) {
    throw forbiddenError("Only the Marketing Manager can send the approved requests email.");
  }
  const dryRun = body.dryRun === true;
  const range = resolveCeoApprovalsRange(
    { from: typeof body.from === "string" ? body.from : null, to: typeof body.to === "string" ? body.to : null },
    todayInCairo(),
  );
  const report = await getMarketingCeoApprovals(access, range);

  let picked: ReturnType<typeof normalizeEmailSelection>;
  try {
    picked = normalizeEmailSelection(body.rows, report.rows);
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : "The ticked requests could not be read.");
  }

  const requesterHrIds = Array.from(new Set(picked.map(({ row }) => row.requesterHrId).filter((id): id is string => Boolean(id))));
  const people = await loadPeople([
    ...APPROVED_REQUESTS_TO_HR_IDS,
    ...APPROVED_REQUESTS_FIXED_CC_HR_IDS,
    ...requesterHrIds,
    ...(access.hrId ? [access.hrId] : []),
  ]);
  const recipients = resolveApprovedRequestsRecipients({ people, requesterHrIds, senderHrId: access.hrId });
  const sender = people.get(canonicalHrIdKey(access.hrId) ?? "");
  const finance = people.get(canonicalHrIdKey(APPROVED_REQUESTS_FINANCE_CONTACT_HR_ID) ?? "");

  const emailRows = picked.map(({ mark, note, row }) => ({
    customerName: row.customerName,
    estimatedCost: row.estimatedCost,
    lineName: row.lineName,
    mark,
    note,
    requestType: row.requestType,
    requesterName: row.requesterName,
  }));
  const content: ApprovedRequestsEmailContent = {
    financeContactName: finance?.name ?? "Ahmed El Maraghy",
    holdNames: financeHoldNames(emailRows),
    range,
    rows: emailRows,
    senderName: sender?.name ?? "Marketing",
    senderTitle: sender?.jobTitle ?? null,
  };
  const subject = approvedRequestsSubject(range);
  const preview: ApprovedRequestsEmailPreview = {
    cc: visible(recipients.cc),
    holdNames: content.holdNames,
    redCount: emailRows.filter((row) => row.mark === "executed").length,
    rowCount: emailRows.length,
    subject,
    to: visible(recipients.to),
    totalValue: emailRows.reduce((sum, row) => sum + row.estimatedCost, 0),
    warnings: recipients.warnings,
  };

  if (recipients.to.length === 0) {
    throw validationError("Neither Finance recipient has a working email address, so nothing was sent.");
  }
  if (recipients.to.length + recipients.cc.length > APPROVED_REQUESTS_MAX_RECIPIENTS) {
    throw validationError(
      `This email would reach ${recipients.to.length + recipients.cc.length} people; one email reaches at most ${APPROVED_REQUESTS_MAX_RECIPIENTS}. Untick some requests and send them in a second email.`,
    );
  }
  if (dryRun) return { ...preview, sent: false, sentAtIso: null, skippedReason: null };

  assertNotTestAccount(access);
  assertNotSeatView(access);

  const { html, text } = renderApprovedRequestsEmail(content);
  // Same rows, marks, notes and range → the same key, so a double press sends one email.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ range, rows: picked.map(({ mark, note, row }) => [row.requestId, mark, note]), sender: access.hrId }))
    .digest("hex")
    .slice(0, 32);
  const idempotencyKey = `marketing-approved-requests:${fingerprint}`;
  const senderEmail = String(sender?.email ?? "").trim();

  const result = await sendPhoenixEmail({
    cc: recipients.cc.map((person) => person.email),
    from: `${content.senderName} via Phoenix <${systemEmail.defaultFromEmail}>`,
    html,
    idempotencyKey,
    origin: { eventType: APPROVED_REQUESTS_EMAIL_EVENT, module: APPROVED_REQUESTS_EMAIL_MODULE },
    replyTo: senderEmail || undefined,
    subject,
    text,
    to: recipients.to.map((person) => person.email),
  });
  const sentAtIso = new Date().toISOString();

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId ?? null,
    entityId: idempotencyKey,
    entityType: "marketing_request",
    newValues: {
      cc: recipients.cc.map((person) => person.hrId),
      requestIds: picked.map(({ row }) => row.requestId),
      sent: !result.skipped,
      skippedReason: result.skipped ? result.reason : null,
      subject,
      to: recipients.to.map((person) => person.hrId),
    },
    summary: result.skipped
      ? `Approved requests email for ${subject.replace(/^Approved requests /, "")} was not sent: ${result.reason}`
      : `Sent the approved requests email for ${subject.replace(/^Approved requests /, "")} (${emailRows.length} requests)`,
  });

  if (result.skipped) {
    return { ...preview, sent: false, sentAtIso: null, skippedReason: result.reason };
  }

  // The email is the act; the bell and Telegram copies never hold up his answer.
  await afterResponse("marketing_notice:approved_requests_sent", async () => {
    try {
      await createSystemNotificationForRecipients(
        {
          category: "general",
          channels: ["in_app", "telegram"],
          eventType: APPROVED_REQUESTS_EMAIL_EVENT,
          message: approvedRequestsNoticeMessage(content),
          metadata: { idempotencyKey, requestIds: picked.map(({ row }) => row.requestId) },
          module: APPROVED_REQUESTS_EMAIL_MODULE,
          priority: "normal",
          title: subject,
        },
        recipients.notifyHrIds,
      );
    } catch (error) {
      logError("marketing_approved_requests_notice_failed", {
        error,
        labels: { event: "marketing_approved_requests_notice_failed" },
        context: { idempotencyKey, recipients: recipients.notifyHrIds.length },
      });
    }
  });

  return { ...preview, sent: true, sentAtIso, skippedReason: null };
}
