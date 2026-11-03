import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import {
  readEmployeeEmails,
  type EmployeeEmailDbRow,
  type SuppressionDbRow,
} from "@/lib/email/suppression-admin";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { hrIdsForRoles } from "@/lib/recruitment/inbound/recruitment-notify";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Tells the Super Admin when an active employee's work email is newly blocked (owner, 2026-11-03). It
 * rides the job-heartbeat sweep, so it needs no cron of its own, and like the other watches there it
 * swallows its own errors and never changes that route's verdict.
 *
 * In-app, Telegram and push, never email: this is about an address that email cannot reach, and the
 * standing rule is that no watch adds an outbound email. Only rows created inside 48 hours count, so the
 * blocks from 4 October, which the screen already lists, do not page anyone on deploy. A lifted address
 * that bounces again is a new row, so it pages again, which is right.
 */

const WINDOW_MS = 48 * 60 * 60 * 1000;
const ACTION_URL = "/admin/notifications/email";

export type NewlyBlockedPerson = { address: string; hrId: string; name: string };

export type EmailBlockWatchResult = {
  delivered: boolean;
  people: number;
  skippedReason: string | null;
};

/** Pure. Active employees only; a candidate's or a leaver's address is on the screen and pages nobody. */
export function newlyBlockedPeople(
  suppressions: readonly Pick<SuppressionDbRow, "address" | "created_at">[],
  employees: readonly EmployeeEmailDbRow[],
  nowMs: number,
): NewlyBlockedPerson[] {
  const fresh = new Set(
    suppressions
      .filter((row) => nowMs - Date.parse(row.created_at) <= WINDOW_MS)
      .map((row) => row.address.trim().toLowerCase()),
  );
  const people = new Map<string, NewlyBlockedPerson>();
  for (const employee of employees) {
    const address = employee.work_email?.trim().toLowerCase();
    if (!address || !fresh.has(address) || isTerminalEmploymentStatus(employee.employment_status)) continue;
    people.set(employee.hr_id, { address, hrId: employee.hr_id, name: employee.full_name ?? employee.hr_id });
  }
  return [...people.values()].sort((left, right) => left.hrId.localeCompare(right.hrId));
}

/** Pure. The key holds the set of people, so a new person gets through and the same set says it once. */
export function emailBlockNotice(people: readonly NewlyBlockedPerson[]): { idempotencyKey: string; message: string; title: string } {
  return {
    idempotencyKey: `email-block:${people.map((person) => person.hrId).join(",")}`,
    message: [
      "Phoenix has stopped emailing these work addresses because the email provider refused them:",
      ...people.map((person) => `• ${person.name}: ${person.address}`),
      "They get no email until the block is lifted, and they cannot reset their own password. Lifting sends nothing, and if the mailbox does not exist, create it first.",
    ].join("\n"),
    title: people.length === 1 ? `Work email blocked: ${people[0].name}` : `${people.length} work emails blocked`,
  };
}

export async function runEmailBlockWatch(): Promise<EmailBlockWatchResult> {
  try {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { data, error } = await getSupabaseAdmin()
      .from("email_suppressions")
      .select("address, created_at")
      .gte("created_at", since);
    if (error) throw error;
    const rows = (data ?? []) as Array<Pick<SuppressionDbRow, "address" | "created_at">>;
    if (rows.length === 0) return { delivered: false, people: 0, skippedReason: "nothing new" };

    const people = newlyBlockedPeople(rows, await readEmployeeEmails(), Date.now());
    if (people.length === 0) return { delivered: false, people: 0, skippedReason: "no active employee" };

    const recipients = await hrIdsForRoles(["Super Admin"]);
    if (recipients.length === 0) return { delivered: false, people: people.length, skippedReason: "no recipient" };

    const notice = emailBlockNotice(people);
    await createSystemNotificationForRecipients(
      {
        actionUrl: ACTION_URL,
        actorId: "email-block-watch",
        channels: ["in_app", "telegram", "push"],
        eventType: "email_block_new",
        message: notice.message,
        metadata: { idempotencyKey: notice.idempotencyKey },
        // `system` is the module enabled for Telegram; an unknown module string fails closed.
        module: "system",
        priority: "high",
        telegram: { ctaLabel: "Open Email Delivery Status", ctaUrl: ACTION_URL },
        title: notice.title,
      },
      recipients,
    );
    return { delivered: true, people: people.length, skippedReason: null };
  } catch (error) {
    logError("The blocked work email watch failed", { error, labels: { event: "email_block_watch_failed" } });
    return { delivered: false, people: 0, skippedReason: "the watch could not run" };
  }
}
