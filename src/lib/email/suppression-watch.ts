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
 * standing rule is that no watch adds an outbound email (operator-watch-channel-guard.ts stops the
 * Telegram-failure re-send too). Only a block that stops every email counts: a hard bounce or a complaint
 * with no expiry. An unsubscribe still lets account and security email through, and a soft bounce clears
 * itself in 7 days. Only rows written inside 48 hours count, so the blocks from 4 October, which the screen
 * already lists, do not page anyone on deploy. The clock is `updated_at` because a repeat bounce refreshes
 * the row and keeps its old `created_at`, so a lifted address that bounces again pages again.
 */

const WINDOW_MS = 48 * 60 * 60 * 1000;
const STOPS_EVERY_EMAIL: ReadonlySet<string> = new Set(["hard_bounce", "complaint"]);
const ACTION_URL = "/admin/notifications/email";

export type NewlyBlockedPerson = { address: string; blockedAt: string; hrId: string; name: string; reason: string };

export type EmailBlockWatchResult = {
  delivered: boolean;
  people: number;
  skippedReason: string | null;
};

/** Pure. Active employees only; a candidate's or a leaver's address is on the screen and pages nobody. */
export function newlyBlockedPeople(
  suppressions: readonly Pick<SuppressionDbRow, "address" | "expires_at" | "reason" | "updated_at">[],
  employees: readonly EmployeeEmailDbRow[],
  nowMs: number,
): NewlyBlockedPerson[] {
  const fresh = new Map(
    suppressions
      .filter((row) => STOPS_EVERY_EMAIL.has(row.reason) && !row.expires_at && nowMs - Date.parse(row.updated_at) <= WINDOW_MS)
      .map((row) => [row.address.trim().toLowerCase(), row] as const),
  );
  const people = new Map<string, NewlyBlockedPerson>();
  for (const employee of employees) {
    const address = employee.work_email?.trim().toLowerCase();
    const block = address ? fresh.get(address) : undefined;
    if (!address || !block || isTerminalEmploymentStatus(employee.employment_status)) continue;
    people.set(employee.hr_id, {
      address,
      blockedAt: block.updated_at,
      hrId: employee.hr_id,
      name: employee.full_name ?? employee.hr_id,
      reason: block.reason,
    });
  }
  return [...people.values()].sort((left, right) => left.hrId.localeCompare(right.hrId));
}

/**
 * Pure. The key is the newest block, person and time. A new block always gets through, the same state says
 * it once, one person leaving the 48-hour window does not repeat the others, and a block that comes back
 * after a lift has a new time. The delivery claim on a key is never pruned, so a key with no time would be
 * silent for that person for good.
 */
export function emailBlockNotice(people: readonly NewlyBlockedPerson[]): { idempotencyKey: string; message: string; title: string } {
  const newest = [...people].sort((left, right) => right.blockedAt.localeCompare(left.blockedAt) || left.hrId.localeCompare(right.hrId))[0];
  const refused = people.filter((person) => person.reason !== "complaint");
  const complained = people.filter((person) => person.reason === "complaint");
  return {
    idempotencyKey: `email-block:${newest?.hrId ?? "none"}@${newest?.blockedAt ?? "none"}`,
    message: [
      ...(refused.length > 0
        ? [
            "Phoenix has stopped emailing these work addresses because the email provider refused them:",
            ...refused.map((person) => `• ${person.name}: ${person.address}`),
            "They get no email until the block is lifted, and they cannot reset their own password. Lifting sends nothing, and if the mailbox does not exist, create it first.",
          ]
        : []),
      ...(complained.length > 0
        ? [
            "Phoenix has stopped emailing these work addresses because the person marked a Phoenix email as spam:",
            ...complained.map((person) => `• ${person.name}: ${person.address}`),
            "They get no email and cannot reset their own password. A complaint is theirs to withdraw, so it cannot be lifted from the screen.",
          ]
        : []),
    ].join("\n"),
    title: people.length === 1 ? `Work email blocked: ${people[0].name}` : `${people.length} work emails blocked`,
  };
}

export async function runEmailBlockWatch(): Promise<EmailBlockWatchResult> {
  try {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { data, error } = await getSupabaseAdmin()
      .from("email_suppressions")
      .select("address, reason, expires_at, updated_at")
      .gte("updated_at", since);
    if (error) throw error;
    const rows = (data ?? []) as Array<Pick<SuppressionDbRow, "address" | "expires_at" | "reason" | "updated_at">>;
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
