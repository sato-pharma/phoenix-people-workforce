// Recruitment — the weekly interview DIGEST (owner, 2026-09-26, Tier 2).
//
// A once-a-week summary of the interview calendar: how many interviews are coming up, how many were
// held, how many are decided vs still awaiting a decision, attended vs did-not-come, and the average
// days to a decision. It goes to the SUPER ADMIN(s) ONLY — the owner's choice, "HR / Super Admin
// only" — by IN-APP and TELEGRAM, never e-mail, and NEVER to the CEO (the CEO is not a Super Admin,
// and resolveSuperAdminRecipients returns only Super Admins). It reports numbers; it changes nothing.
//
// NO LEDGER TABLE — each message carries a weekly idempotency key and createSystemNotification
// delivers a key once, so a job that runs more than once in the week tells nobody twice.

import { createSystemNotification } from "@/lib/notifications/system";
import { resolveSuperAdminRecipients } from "@/lib/private-calendar/notify-admin";
import { summarizeInterviewsForDigest, type InterviewDigestSummary } from "@/lib/recruitment/interview-calendar";
import { cairoDateKey, formatDayLong, weekStartFor } from "@/lib/recruitment/interview-calendar-week";

const PORTAL_BASE = "/employee-portals/interview-calendar";

export type InterviewDigest = {
  recipientHrId: string;
  key: string;
  title: string;
  message: string;
  metrics: Array<{ label: string; value: string }>;
};

function sentence(summary: InterviewDigestSummary): string {
  const bits = [
    `${summary.upcomingCount} coming up in the next ${summary.windowDays} days`,
    `${summary.heldCount} held in the last ${summary.windowDays} (${summary.decidedCount} decided, ${summary.awaitingCount} awaiting a decision)`,
    `${summary.attendedCount} attended, ${summary.noShowCount} did not come`,
  ];
  if (summary.avgDaysToDecision !== null) bits.push(`about ${summary.avgDaysToDecision} days to a decision on average`);
  return `${bits.join("; ")}.`;
}

/** The digest to send at `now` — one per Super Admin recipient, keyed to this week so it sends once. */
export function planInterviewDigest(summary: InterviewDigestSummary, recipientHrIds: readonly string[], now: Date): InterviewDigest[] {
  const weekKey = weekStartFor(cairoDateKey(now));
  const message = sentence(summary);
  const metrics = [
    { label: "Coming up", value: String(summary.upcomingCount) },
    { label: "Held", value: String(summary.heldCount) },
    { label: "Decided", value: String(summary.decidedCount) },
    { label: "Awaiting a decision", value: String(summary.awaitingCount) },
    { label: "Attended", value: String(summary.attendedCount) },
    { label: "Did not come", value: String(summary.noShowCount) },
    { label: "Avg days to decision", value: summary.avgDaysToDecision === null ? "—" : String(summary.avgDaysToDecision) },
  ];
  const title = `Interview week — ${formatDayLong(weekKey)}`;
  // De-duplicate recipients (a person could be listed twice); one digest each, once this week.
  const seen = new Set<string>();
  const digests: InterviewDigest[] = [];
  for (const hrId of recipientHrIds) {
    const trimmed = hrId?.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    digests.push({ key: `interview-digest:${weekKey}:${trimmed}`, message, metrics, recipientHrId: trimmed, title });
  }
  return digests;
}

export type InterviewDigestSend = (digest: InterviewDigest) => Promise<boolean>;

/** In-app + Telegram only — never e-mail, and (by the recipient set) never the CEO. */
export const sendInterviewDigest: InterviewDigestSend = async (digest) => {
  const result = await createSystemNotification({
    actionUrl: PORTAL_BASE,
    channels: ["in_app", "telegram"],
    eventType: "recruitment_interview_digest",
    message: digest.message,
    metadata: { idempotencyKey: digest.key },
    module: "recruitment",
    priority: "normal",
    recipientHrId: digest.recipientHrId,
    title: digest.title,
  });
  return result.deliveries.some((delivery) => delivery.status === "sent" || delivery.status === "pending" || delivery.status === "retrying");
};

export type InterviewDigestRun = { recipients: number; delivered: number; failed: number };

export async function runInterviewDigest(
  now: Date = new Date(),
  send: InterviewDigestSend = sendInterviewDigest,
  summarize: (now: Date) => Promise<InterviewDigestSummary> = (at) => summarizeInterviewsForDigest(at),
  recipients: () => Promise<Array<{ hrId: string }>> = resolveSuperAdminRecipients,
): Promise<InterviewDigestRun> {
  const [summary, people] = await Promise.all([summarize(now), recipients()]);
  const plan = planInterviewDigest(summary, people.map((person) => person.hrId), now);
  let delivered = 0;
  let failed = 0;
  for (const digest of plan) {
    try {
      if (await send(digest)) delivered += 1;
    } catch {
      failed += 1;
    }
  }
  return { delivered, failed, recipients: plan.length };
}
