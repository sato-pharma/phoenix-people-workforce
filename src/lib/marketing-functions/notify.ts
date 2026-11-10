// Marketing Functions — the notices. In-app only (the bell): no email, no Telegram.
//
// Two moments: he submits his month (his direct manager — Dr. Rasha for Dr. Ahmed — is told it waits
// for her review), and a reviewer stamps it Reviewed or reopens it (he is told). Best effort by
// design: a month that was submitted or reviewed is never lost because a bell could not ring — a
// failure is logged, never thrown. Callers run these inside `afterResponse`.

import { canonicalPersonHrId } from "@/lib/auth/identity-aliases";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";

import { monthKeyOf, monthTitle } from "./months";

export const MARKETING_FUNCTIONS_PAGE_PATH = "/employee-portals/marketing-functions";

type MonthRef = { id: string; author_hr_id: string; month: string; status: string; submitted_at?: string | null; reviewed_at?: string | null };

function sheetUrl(month: MonthRef): string {
  const params = new URLSearchParams({ author: month.author_hr_id, month: monthKeyOf(month.month) });
  return `${MARKETING_FUNCTIONS_PAGE_PATH}?${params.toString()}`;
}

async function send(input: {
  eventType: string;
  idempotencyKey: string;
  message: string;
  recipients: string[];
  month: MonthRef;
  title: string;
}): Promise<number> {
  const recipients = [
    ...new Set(input.recipients.map((hrId) => canonicalPersonHrId(hrId)).filter((hrId): hrId is string => Boolean(hrId))),
  ];
  if (recipients.length === 0) return 0;
  try {
    await createSystemNotificationForRecipients(
      {
        actionUrl: sheetUrl(input.month),
        category: "general",
        channels: ["in_app"],
        eventType: input.eventType,
        message: input.message,
        metadata: { idempotencyKey: input.idempotencyKey, monthId: input.month.id },
        module: "marketing_functions",
        priority: "normal",
        recordId: input.month.id,
        subjectHrId: input.month.author_hr_id,
        title: input.title,
      },
      recipients,
    );
    return recipients.length;
  } catch (error) {
    console.warn("[marketing-functions] a notice could not be created", error);
    return 0;
  }
}

async function authorAndManager(authorHrId: string): Promise<{ name: string; managerHrId: string | null }> {
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const author = directory.find((employee) => canonicalHrIdKey(employee.hrId) === canonicalHrIdKey(authorHrId));
  return { name: author?.displayName ?? authorHrId, managerHrId: author?.managerHrId ?? null };
}

/** He submitted his month: his direct manager reviews it. */
export async function notifyMonthSubmitted(month: MonthRef): Promise<number> {
  const { name, managerHrId } = await authorAndManager(month.author_hr_id);
  const title = monthTitle(monthKeyOf(month.month));
  return send({
    eventType: "marketing_functions.month_submitted",
    idempotencyKey: `marketing_functions:submitted:${month.id}:${month.submitted_at ?? ""}`,
    message: `${name} submitted the Monthly Marketing Functions sheet for ${title}. It is waiting for your review.`,
    month,
    recipients: managerHrId ? [managerHrId] : [],
    title: "A Monthly Marketing Functions sheet is waiting for your review",
  });
}

/** A reviewer stamped his month Reviewed, or reopened it for him. */
export async function notifyMonthReviewed(month: MonthRef, decision: "review" | "reopen", reviewerName: string): Promise<number> {
  const title = monthTitle(monthKeyOf(month.month));
  return send({
    eventType: decision === "review" ? "marketing_functions.month_reviewed" : "marketing_functions.month_reopened",
    idempotencyKey: `marketing_functions:${decision}:${month.id}:${month.reviewed_at ?? new Date().toISOString()}`,
    message:
      decision === "review"
        ? `${reviewerName} reviewed your Monthly Marketing Functions sheet for ${title}.`
        : `${reviewerName} reopened your Monthly Marketing Functions sheet for ${title} so you can change it.`,
    month,
    recipients: [month.author_hr_id],
    title: decision === "review" ? "Your month was reviewed" : "Your month was reopened",
  });
}
