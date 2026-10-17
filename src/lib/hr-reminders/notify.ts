// HR Reminders — the bell notice for a comment.
//
// In-app only. A note between four colleagues is not worth an email, a Telegram or a phone buzz
// (the policy row says the same; the single channel passed here is what actually binds). Best
// effort by design: a comment that was saved is never lost because the bell could not be rung, and
// a failure is logged, never thrown into the request.

import { createSystemNotification } from "@/lib/notifications/system";
import type { ReminderCommentView, ReminderRecord, TeamMember } from "@/lib/hr-reminders/types";

const PAGE_PATH = "/hr-reminders";
const HR_PAGE_PATH = "/hr/hr-reminders";

/** The HR Manager opens the module at its admin address, the HR seats inside the `/hr` namespace. */
export function reminderActionUrl(reminderId: string, member: Pick<TeamMember, "isOverseer"> | null): string {
  const base = member?.isOverseer ? PAGE_PATH : HR_PAGE_PATH;
  return `${base}?open=${encodeURIComponent(reminderId)}`;
}

export async function notifyReminderComment(input: {
  authorHrId: string;
  authorName: string;
  comment: Pick<ReminderCommentView, "body" | "id">;
  recipientHrIds: readonly string[];
  reminder: Pick<ReminderRecord, "id" | "title">;
  team: readonly TeamMember[];
}): Promise<void> {
  if (input.recipientHrIds.length === 0) return;

  const results = await Promise.allSettled(
    input.recipientHrIds.map((recipientHrId) => {
      const member = input.team.find((candidate) => candidate.hrId.toLowerCase() === recipientHrId.toLowerCase()) ?? null;
      return createSystemNotification({
        actionUrl: reminderActionUrl(input.reminder.id, member),
        actorId: input.authorHrId,
        category: "general",
        channels: ["in_app"],
        eventType: "hr_reminders.comment",
        // The whole comment, never a clipped one: the bell wraps it, and a cut sentence is worse than a long one.
        message: `${input.authorName}: ${input.comment.body}`,
        metadata: {
          commentId: input.comment.id,
          idempotencyKey: `hr_reminders:comment:${input.comment.id}:${recipientHrId.toLowerCase()}`,
          reminderId: input.reminder.id,
        },
        module: "hr_reminders",
        priority: "normal",
        recipientHrId,
        recordId: input.reminder.id,
        title: `${input.authorName} commented on "${input.reminder.title}"`,
      });
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("[hr-reminders] a comment notice could not be created", result.reason);
    }
  }
}
