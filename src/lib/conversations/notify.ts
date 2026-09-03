// Conversation notifications — one shared addressing rule for every comment thread in the system.
//
// The owner's rule, 2026-09-03: "if someone sent anything in a conversation, or returned the plan,
// or in any conversation type in the system, when anyone types anything, email goes to the
// submitter, CC the sender."
//
// Before this module only ONE of the system's conversations emailed anybody at all — the weekly /
// monthly plan thread — and even that one addressed it wrongly, sending a separate private message
// per participant. Candidate comments, deductions comments and the marketing advisory note inserted
// a row and told nobody.
//
// So the addressing lives here rather than in each domain: a rule copied into four services is a
// rule that will be four different rules within a year.
//
//   To   the SUBMITTER — whoever owns the thing being discussed.
//   CC   the SENDER (the owner's words) plus every other participant.
//   In-app / Telegram / push  everyone except the author; nobody needs a ping about their own
//        message, and the emailed copy is what puts it in front of them.
//
// Best-effort by contract: every caller has already committed its comment row by the time this
// runs, so a delivery failure must be logged and swallowed, never thrown back into the write path.

import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type ConversationNotificationInput = {
  /** Where a recipient should land to read and reply. */
  actionUrl: string;
  authorHrId: string | null;
  authorName: string | null;
  /** The message as typed. Never pre-truncate it — see the note on `message` below. */
  body: string;
  eventType: string;
  /** Extra context carried on the notification row, for later auditing. */
  metadata?: Record<string, unknown>;
  /** Notification module key, e.g. "recruitment" / "marketing_requests". */
  module: string;
  /** Everyone engaged with the thread so far, in any order. Duplicates and blanks are fine. */
  participantHrIds: Array<string | null | undefined>;
  recordId: string;
  /** The person the thread belongs to — the email's To. */
  submitterHrId: string | null;
  /** What is being discussed, e.g. "Mahmoud Sami" or "MR-2026-014". Used in the title. */
  subjectLabel: string;
  /** Human name of the thread type, e.g. "candidate" or "marketing request". */
  threadLabel: string;
};

/**
 * Work emails for a set of HR ids, keyed by canonical id.
 *
 * `hrIdLookupKeys` on every id rather than one normalized form: `employees.hr_id` is stored
 * UPPER-case in 185 of its 186 rows, while the app's comparison key is lower-case, so an `.in()`
 * over canonical keys matches nothing at all. Measured on production 2026-09-03 — the lower-case
 * form returned 0 rows where the stored form returned 3. It is a silent failure that removes people
 * from the cc line rather than raising anything, which is the exact defect this module exists to
 * end, so it must not be reintroduced by "tidying" this lookup back to a single key.
 */
async function loadWorkEmails(hrIds: Array<string | null>): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const lookups = Array.from(new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId))));
  if (lookups.length === 0) return output;
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id,work_email")
    .in("hr_id", lookups);
  if (error) return output;
  for (const row of (data ?? []) as Array<{ hr_id?: string | null; work_email?: string | null }>) {
    const canonical = canonicalHrIdKey(row.hr_id);
    const email = pickDeliverableEmail(row.work_email);
    if (canonical && email) output.set(canonical, email);
  }
  return output;
}

/**
 * The HR seats, resolved by APP ROLE.
 *
 * Never by job title. The owner's standing rule is that an HR seat is composed from a function
 * catalogue and is never named after a job title, and this repository has a live demonstration of
 * why: `hrAcknowledgementRecipients` in weekly-planning/service.ts matches
 * `job_title ilike '%HR Manager%'` / `'%Admin HR%'`, and production returns ZERO employees for
 * either (measured 2026-09-03). Titles drift; the role is what the app actually gates on.
 *
 * `HR Advisory` and `HR Operations` are the two HR seats, the same pair `hrAuthorityNavigationRoles`
 * names in system-navigation.ts. That constant is not imported here on purpose - navigation is UX
 * only, and a notification audience must not be able to change because somebody re-arranged a
 * sidebar.
 *
 * Falls back to Super Admin when both seats are empty, so an unstaffed HR function loses the
 * mailbox rather than the message.
 */
export const HR_SEAT_ROLES = ["HR Advisory", "HR Operations"] as const;

async function resolveHrAudience(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("hr_id,role,is_active")
    .in("role", [...HR_SEAT_ROLES]);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ hr_id?: string | null; is_active?: boolean | null }>;
  const hrIds = rows
    .filter((row) => row.is_active !== false)
    .map((row) => row.hr_id)
    .filter((hrId): hrId is string => Boolean(hrId));
  if (hrIds.length > 0) return hrIds;

  const { data: admins } = await supabase
    .from("app_auth_users")
    .select("hr_id,is_active")
    .eq("role", "Super Admin");
  const fallback = ((admins ?? []) as Array<{ hr_id?: string | null; is_active?: boolean | null }>)
    .filter((row) => row.is_active !== false)
    .map((row) => row.hr_id)
    .filter((hrId): hrId is string => Boolean(hrId));
  if (fallback.length > 0) {
    logError("No active HR seat to receive a conversation - falling back to Super Admin", {
      labels: { event: "conversation_hr_audience_empty" },
    });
  }
  return fallback;
}

/**
 * Deliver a comment whose audience is HR rather than an individual thread owner.
 *
 * Owner's answer, 2026-09-03, asked before any recipient was wired: "HR gets the deductions
 * comment." So HR is the To and the employee who wrote it is the CC - the same shape as every
 * other thread, with HR standing in as the side that owns the conversation.
 */
export async function notifyHrConversationMessage(
  input: Omit<ConversationNotificationInput, "submitterHrId" | "participantHrIds">,
): Promise<void> {
  try {
    const hrIds = await resolveHrAudience();
    if (hrIds.length === 0) {
      logError("No HR recipient at all for a conversation message", {
        labels: { event: "conversation_hr_audience_unresolved", module: input.module, recordId: input.recordId },
      });
      return;
    }
    await notifyConversationMessage({
      ...input,
      participantHrIds: hrIds,
      submitterHrId: hrIds[0],
    });
  } catch (error) {
    logError("HR conversation message failed to notify", {
      labels: { event: "conversation_hr_notify_failed", module: input.module, recordId: input.recordId },
      error,
    });
  }
}

/**
 * The addressing decision, split out so it can be asserted directly in a test without a database.
 *
 * Ids come back in the form they were GIVEN, deduplicated by canonical key. Returning the canonical
 * key itself would be wrong twice over: it is lower-cased, so it neither matches the stored
 * `employees.hr_id` for an email lookup nor is the right thing to persist on a notification row.
 * The submitter is always first in `notifyKeys` because the email envelope is attached to the
 * primary recipient, and the primary is the To.
 */
export function resolveConversationAudience(input: {
  authorHrId: string | null | undefined;
  participantHrIds: Array<string | null | undefined>;
  submitterHrId: string | null | undefined;
}): { ccKeys: string[]; notifyKeys: string[] } {
  const authorKey = canonicalHrIdKey(input.authorHrId);
  const submitterKey = canonicalHrIdKey(input.submitterHrId);

  // Canonical key -> the id as supplied, first spelling wins.
  const byKey = new Map<string, string>();
  for (const raw of [input.submitterHrId, ...input.participantHrIds]) {
    const key = canonicalHrIdKey(raw);
    if (key && !byKey.has(key)) byKey.set(key, String(raw).trim());
  }

  const notifyKeys = [
    ...(submitterKey && byKey.has(submitterKey) ? [byKey.get(submitterKey) as string] : []),
    ...Array.from(byKey.entries())
      .filter(([key]) => key !== submitterKey && key !== authorKey)
      .map(([, value]) => value),
  ];

  // The sender is copied even when they are also the submitter: "CC the sender" means the person
  // who typed it receives the copy, and collapsing To and CC onto one address is a mail client's
  // problem, not ours. Only the To itself is removed from the cc.
  const ccByKey = new Map(byKey);
  if (authorKey && !ccByKey.has(authorKey)) ccByKey.set(authorKey, String(input.authorHrId).trim());
  if (submitterKey) ccByKey.delete(submitterKey);

  return { ccKeys: Array.from(ccByKey.values()), notifyKeys };
}

/**
 * Deliver one conversation message to everyone who should see it.
 *
 * One email, addressed To the submitter and CC'ing the sender and the rest of the thread — rather
 * than one private email each, which is what the plan thread used to do and why nobody could tell
 * from their own inbox who else was in the conversation.
 */
export async function notifyConversationMessage(input: ConversationNotificationInput): Promise<void> {
  try {
    const { ccKeys, notifyKeys } = resolveConversationAudience({
      authorHrId: input.authorHrId,
      participantHrIds: input.participantHrIds,
      submitterHrId: input.submitterHrId,
    });
    if (notifyKeys.length === 0 && ccKeys.length === 0) return;

    const emails = await loadWorkEmails([...notifyKeys, ...ccKeys]);
    const emailFor = (hrId: string) => {
      const key = canonicalHrIdKey(hrId);
      return key ? emails.get(key) ?? null : null;
    };
    const primaryHrId = notifyKeys[0] ?? null;
    const primaryEmail = primaryHrId ? emailFor(primaryHrId) : null;
    const ccEmails = Array.from(new Set(
      ccKeys.map(emailFor).filter((email): email is string => Boolean(email)),
    ));

    const author = input.authorName?.trim() || input.authorHrId || "Someone";
    // The message carries the comment IN FULL. The owner's standing rule is that text is never
    // truncated with an ellipsis, and a clipped preview is what forces the reader back into the app
    // to find out what was actually said — the opposite of what an emailed thread is for.
    const message = `${author} commented on the ${input.threadLabel} ${input.subjectLabel}: "${input.body}"`;
    const title = `New comment on ${input.threadLabel} ${input.subjectLabel}`;

    await Promise.all(notifyKeys.map((hrId, index) => createSystemNotification({
      actionUrl: input.actionUrl,
      category: "general",
      channels: index === 0
        ? ["in_app", "email", "telegram", "push"]
        : ["in_app", "telegram", "push"],
      // The cc rides on the primary recipient's envelope only — one email with everyone visible on
      // it, not one per person. `recipients` is left undefined when no work email resolved, so
      // createSystemNotification falls back to its own address resolution rather than sending the
      // whole envelope, cc included, to nobody.
      ...(index === 0 && (primaryEmail || ccEmails.length > 0)
        ? {
            email: {
              cc: ccEmails,
              ...(primaryEmail ? { recipients: [primaryEmail] } : {}),
            },
          }
        : {}),
      eventType: input.eventType,
      message,
      metadata: {
        authorHrId: input.authorHrId,
        ccHrIds: ccKeys,
        threadLabel: input.threadLabel,
        ...(input.metadata ?? {}),
      },
      module: input.module,
      priority: "high",
      // Storage form, not the comparison key: writing the lower-case key is what left ~37,000
      // lower-cased actor ids across the database (see hrIdForStorage).
      recipientHrId: hrIdForStorage(hrId),
      recordId: input.recordId,
      subjectHrId: hrIdForStorage(input.submitterHrId),
      title,
    })));
  } catch (error) {
    logError("Conversation message failed to notify participants", {
      labels: { event: "conversation_notify_failed", module: input.module, recordId: input.recordId },
      error,
    });
  }
}
